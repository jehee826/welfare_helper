import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { App } from '../App';
import { ApiError } from '../api/errors';
import { clearAdminSession, saveAdminSession } from '../auth/session';

const {checkAdminAccess} = vi.hoisted(() => ({checkAdminAccess:vi.fn()}));
vi.mock('../api/auth', async original => ({ ...await original<typeof import('../api/auth')>(), checkAdminAccess }));
beforeEach(() => checkAdminAccess.mockResolvedValue({ is_admin: true, access_mode: 'shared_password' }));

afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function LocationProbe() { return <output data-testid="location">{useLocation().search}</output>; }

it('기존 문서 교체는 같은 ID의 PUT이며 선택한 제도의 공개 범위를 전송한다', async () => {
  vi.stubEnv('DEV', true);
  const doc='00000000-0000-0000-0000-000000000001';
  const requests: Array<{url:string; options:RequestInit}> = [];
  const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  vi.stubGlobal('fetch',vi.fn(async (url:string,options:RequestInit)=>{
    if(url.endsWith('/processing'))return json({ready:true});
    if(url.includes('/programs?'))return json({items:[{service_id:'WLF_SAMPLE',program_name:'일반 제도',test_only:false}],next_offset:null});
    if(options?.method==='POST'||options?.method==='PUT'){requests.push({url,options});return json({document_id:doc,job_id:'00000000-0000-0000-0000-000000000003'});}
    return json({document_id:doc,name:'게시 문서',service_id:'WLF_SAMPLE',test_only:false,active_job_id:null,jobs:[]});
  }));
  render(<MemoryRouter initialEntries={['/admin/documents']}><App /></MemoryRouter>);
  await screen.findByRole('option',{name:/일반 제도/});
  fireEvent.change(screen.getByLabelText('연결할 제도'),{target:{value:'WLF_SAMPLE'}});
  for(const [label,value] of [['문서명','합성 문서'],['공개 원문 URL (HTTPS)','https://example.invalid'],['발행 기관','공개 기관'],['교체할 문서 ID (신규 등록은 비움)',doc]])
    fireEvent.change(screen.getByLabelText(label),{target:{value}});
  fireEvent.change(screen.getByLabelText(/원문 파일/),{target:{files:[new File(['합성'],'source.md')]}});
  fireEvent.submit(screen.getByRole('button',{name:'업로드·자동 처리'}).closest('form')!);
  await waitFor(()=>expect(requests).toHaveLength(1));
  expect(requests[0].options.method).toBe('PUT');
  expect(requests[0].url.endsWith('/documents/'+doc)).toBe(true);
  const body=requests[0].options.body as FormData;
  expect(JSON.parse(String(body.get('metadata'))).test_only).toBe(false);
  expect(body.has('document_id')).toBe(false);
});

it.each(['not-uuid', '../other'])('잘못된 교체 ID %s는 파일 전송하지 않는다', async invalid => {
  vi.stubEnv('DEV',true);
  const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  const fetchMock=vi.fn(async(url:string,_options?:RequestInit)=>url.endsWith('/processing')?json({ready:true}):json({items:[{service_id:'WLF_SAMPLE',program_name:'일반 제도',test_only:false}],next_offset:null}));
  vi.stubGlobal('fetch',fetchMock);
  render(<MemoryRouter initialEntries={['/admin/documents']}><App /></MemoryRouter>);
  await screen.findByRole('option',{name:/일반 제도/});
  fireEvent.change(screen.getByLabelText('연결할 제도'),{target:{value:'WLF_SAMPLE'}});
  for(const [label,value] of [['문서명','합성 문서'],['공개 원문 URL (HTTPS)','https://example.invalid'],['발행 기관','공개 기관'],['교체할 문서 ID (신규 등록은 비움)',invalid]])
    fireEvent.change(screen.getByLabelText(label),{target:{value}});
  fireEvent.change(screen.getByLabelText(/원문 파일/),{target:{files:[new File(['합성'],'source.md')]}});
  fireEvent.submit(screen.getByRole('button',{name:'업로드·자동 처리'}).closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('문서 UUID');
  expect(fetchMock.mock.calls.filter(([,options])=>['POST','PUT'].includes((options as RequestInit)?.method ?? ''))).toHaveLength(0);
});

it('삭제된 이전 작업이 URL에 남아도 최신 게시 작업으로 복구한다', async () => {
  vi.stubEnv('DEV', true);
  const doc = '00000000-0000-0000-0000-000000000001';
  const old = '00000000-0000-0000-0000-000000000002';
  const current = '00000000-0000-0000-0000-000000000003';
  const job = { job_id: current, state: 'succeeded', error_code: null, processing_mode: 'automatic', progress: {stored: 1} };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json'}});
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/processing')) return json({ready:true});
    if (url.includes('/programs?')) return json({items:[],next_offset:null});
    if (url.endsWith('/jobs/' + old)) return json({detail:'not_found'}, 404);
    if (url.endsWith('/jobs/' + current)) return json(job);
    return json({document_id:doc, name:'최신 게시 문서', service_id:'WLF_SAMPLE', source_organization:'공개 기관',
      test_only:false, active_job_id:current, jobs:[job]});
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter initialEntries={[`/admin/documents?document=${doc}&job=${old}`]}><App /><LocationProbe /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('button',{name:'실행'})).toBeEnabled());
  expect(screen.getByText('최신 게시 문서')).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/jobs/' + current))).toBe(true);
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/jobs/' + old))).toBe(false);
  expect(screen.getByTestId('location')).toHaveTextContent('job=' + current);
});

it.each(['failed', 'cancelled'])('후보 %s 후 이전 게시 작업에서만 검색한다', async state => {
  vi.stubEnv('DEV', true);
  const doc='00000000-0000-0000-0000-000000000001', a='00000000-0000-0000-0000-000000000002', b='00000000-0000-0000-0000-000000000003';
  const old={job_id:a,state:'succeeded',processing_mode:'automatic',progress:{stored:1}};
  const candidate={job_id:b,state,processing_mode:'automatic',progress:{stored:0}};
  const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  const fetchMock=vi.fn(async (url:string)=>{
    if(url.endsWith('/processing'))return json({ready:true});
    if(url.includes('/programs?'))return json({items:[],next_offset:null});
    if(url.endsWith('/jobs/'+a))return json(old);
    if(url.endsWith('/jobs/'+b))return json(candidate);
    if(url.endsWith('/search'))return json({chunks:[{chunk_id:'old',text:'이전 게시 원문',section:'content',similarity:.5,pages:[],source_blocks:[],start:0,end:8}]});
    return json({document_id:doc,name:'게시 문서',service_id:'WLF_SAMPLE',source_organization:'공개 기관',test_only:false,active_job_id:a,jobs:[candidate,old]});
  });
  vi.stubGlobal('fetch',fetchMock);
  render(<MemoryRouter initialEntries={[`/admin/documents?document=${doc}&job=${b}`]}><App /></MemoryRouter>);
  await screen.findByText('같은 문서에 새 원문 등록');
  expect(screen.getByRole('button',{name:'실행'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('확인할 작업'),{target:{value:a}});
  await waitFor(()=>expect(screen.getByRole('button',{name:'실행'})).toBeEnabled());
  fireEvent.change(screen.getByLabelText('질문'),{target:{value:'공개 질문'}});
  fireEvent.click(screen.getByRole('button',{name:'실행'}));
  expect(await screen.findByText('이전 게시 원문')).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url])=>url.endsWith('/search'))).toHaveLength(1);
});

it.each(['search','query'])('게시본이 바뀌면 진행 중이던 이전 %s 결과를 버리고 새 게시본을 확인한다', async operation => {
  vi.stubEnv('DEV', true);
  const doc='00000000-0000-0000-0000-000000000001', a='00000000-0000-0000-0000-000000000002', b='00000000-0000-0000-0000-000000000003';
  const job=(id:string)=>({job_id:id,state:'succeeded',processing_mode:'automatic',progress:{stored:1}});
  let active=a, finish!: (value:Response)=>void, searchSignal:AbortSignal|undefined, calls=0;
  const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  vi.stubGlobal('fetch',vi.fn(async (url:string, options:RequestInit)=>{
    if(url.endsWith('/processing'))return json({ready:true});
    if(url.includes('/programs?'))return json({items:[],next_offset:null});
    if(url.includes('/jobs/'))return json(job(url.endsWith(a)?a:b));
    if(url.endsWith('/'+operation)){
      calls += 1;
      if(calls===1){searchSignal=options.signal as AbortSignal;return new Promise<Response>(resolve=>{finish=resolve;});}
      return json(operation==='search'?{chunks:[{chunk_id:'new',text:'새 게시 결과',section:'content',similarity:.5,pages:[],source_blocks:[],start:0,end:6}]}:{response:{kind:'fallback',text:'새 게시 결과',reason:'insufficient_evidence'},diagnostics:{}});
    }
    return json({document_id:doc,name:'게시 문서',service_id:'WLF_SAMPLE',source_organization:'공개 기관',test_only:false,active_job_id:active,jobs:[job(active)]});
  }));
  render(<MemoryRouter initialEntries={[`/admin/documents?document=${doc}&job=${a}`]}><App /></MemoryRouter>);
  await waitFor(()=>expect(screen.getByRole('button',{name:'실행'})).toBeEnabled());
  if(operation==='query')fireEvent.change(screen.getByLabelText('확인 방식'),{target:{value:'query'}});
  fireEvent.change(screen.getByLabelText('질문'),{target:{value:'공개 질문'}});
  fireEvent.click(screen.getByRole('button',{name:'실행'}));
  await waitFor(()=>expect(searchSignal).toBeDefined());
  active=b;
  await waitFor(()=>expect(searchSignal?.aborted).toBe(true),{timeout:7000});
  await act(async()=>{finish(json(operation==='search'?{chunks:[{chunk_id:'old',text:'오래된 결과',section:'content',similarity:.5,pages:[],source_blocks:[],start:0,end:6}]}:{response:{kind:'fallback',text:'오래된 결과',reason:'insufficient_evidence'},diagnostics:{}}));});
  expect(screen.queryByText('오래된 결과')).not.toBeInTheDocument();
  await waitFor(()=>expect(screen.getByRole('button',{name:'실행'})).toBeEnabled());
  fireEvent.change(screen.getByLabelText('질문'),{target:{value:'새 게시 질문'}});
  if(operation==='query')fireEvent.change(screen.getByLabelText('확인 방식'),{target:{value:'query'}});
  fireEvent.click(screen.getByRole('button',{name:'실행'}));
  expect(await screen.findByText('새 게시 결과')).toBeInTheDocument();
  expect(calls).toBe(2);
},10000);

it.each([['upload','leave'],['upload','expire'],['query','leave'],['query','expire']])(
  '%s 진행 중 %s 후 늦은 응답을 표시하지 않는다', async (operation, stop) => {
  vi.stubEnv('DEV',true);
  saveAdminSession({access_token:'synthetic-token',session_id:'synthetic-session',expires_at:Math.floor(Date.now()/1000)+600});
  const doc='00000000-0000-0000-0000-000000000001', job='00000000-0000-0000-0000-000000000002';
  const current={job_id:job,state:'succeeded',processing_mode:'automatic',progress:{stored:1}};
  let finish!:(value:Response)=>void, signal:AbortSignal|undefined;
  const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{
    if(url.endsWith('/processing'))return json({ready:true});
    if(url.includes('/programs?'))return json({items:[{service_id:'WLF_SAMPLE',program_name:'일반 제도',test_only:false}],next_offset:null});
    if(url.includes('/jobs/'))return json(current);
    if((operation==='upload'&&options?.method==='PUT')||(operation==='query'&&url.endsWith('/query'))){signal=options.signal as AbortSignal;return new Promise<Response>(resolve=>{finish=resolve;});}
    return json({document_id:doc,name:'게시 문서',service_id:'WLF_SAMPLE',source_organization:'공개 기관',test_only:false,active_job_id:job,jobs:[current]});
  }));
  const view=render(<MemoryRouter initialEntries={[`/admin/documents?document=${doc}&job=${job}`]}><App /></MemoryRouter>);
  if(operation==='upload'){
    await screen.findByRole('option',{name:/일반 제도/});
    fireEvent.change(screen.getByLabelText('연결할 제도'),{target:{value:'WLF_SAMPLE'}});
    for(const [label,value] of [['문서명','합성 문서'],['공개 원문 URL (HTTPS)','https://example.invalid'],['발행 기관','공개 기관'],['교체할 문서 ID (신규 등록은 비움)',doc]])fireEvent.change(screen.getByLabelText(label),{target:{value}});
    fireEvent.change(screen.getByLabelText(/원문 파일/),{target:{files:[new File(['합성'],'source.md')]}});
    fireEvent.submit(screen.getByRole('button',{name:'업로드·자동 처리'}).closest('form')!);
  }else{
    await waitFor(()=>expect(screen.getByRole('button',{name:'실행'})).toBeEnabled());
    fireEvent.change(screen.getByLabelText('질문'),{target:{value:'공개 질문'}});
    fireEvent.change(screen.getByLabelText('확인 방식'),{target:{value:'query'}});
    fireEvent.click(screen.getByRole('button',{name:'실행'}));
  }
  await waitFor(()=>expect(signal).toBeDefined());
  if(stop==='leave')view.unmount();
  else {checkAdminAccess.mockRejectedValue(new ApiError('expired',401));act(()=>clearAdminSession('synthetic-session'));await screen.findByLabelText('비밀번호');}
  expect(signal?.aborted).toBe(true);
  await act(async()=>finish(json(operation==='upload'?{document_id:doc,job_id:job}:{response:{kind:'fallback',text:'늦은 민감 결과',reason:'insufficient_evidence'},diagnostics:{}})));
  expect(screen.queryByText('늦은 민감 결과')).not.toBeInTheDocument();
});

it('후보 원문을 본 뒤 게시 작업을 선택하면 후보 원문이 사라지고 게시본만 검색한다', async () => {
  vi.stubEnv('DEV',true);
  const doc='00000000-0000-0000-0000-000000000001', a='00000000-0000-0000-0000-000000000002', b='00000000-0000-0000-0000-000000000003';
  const old={job_id:a,state:'succeeded',processing_mode:'automatic',progress:{stored:1}}, candidate={job_id:b,state:'embedding',processing_mode:'automatic',progress:{stored:0}};
  const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    if(url.endsWith('/processing'))return json({ready:true});
    if(url.includes('/programs?'))return json({items:[],next_offset:null});
    if(url.endsWith('/jobs/'+a))return json(old);
    if(url.endsWith('/jobs/'+b))return json(candidate);
    if(url.endsWith('/markdown'))return new Response('후보 B 원문',{status:200,headers:{'Content-Type':'text/plain'}});
    if(url.endsWith('/search'))return json({chunks:[{chunk_id:'old',text:'게시 A 검색 결과',section:'content',similarity:.5,pages:[],source_blocks:[],start:0,end:6}]});
    return json({document_id:doc,name:'게시 문서',service_id:'WLF_SAMPLE',source_organization:'공개 기관',test_only:false,active_job_id:a,jobs:[candidate,old],analysis:{hash:'hash-b',job_id:b,scope:'candidate',blockers:[],warnings:[],total_blocks:1,blocks:[],next_offset:null}});
  }));
  render(<MemoryRouter initialEntries={[`/admin/documents?document=${doc}&job=${b}`]}><App /></MemoryRouter>);
  await waitFor(()=>expect(screen.getByRole('button',{name:'원문 불러오기'})).toBeEnabled());
  fireEvent.click(screen.getByText('추출된 원문 확인 (선택)'));
  fireEvent.click(screen.getByRole('button',{name:'원문 불러오기'}));
  expect(await screen.findByText('후보 B 원문')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('확인할 작업'),{target:{value:a}});
  await waitFor(()=>expect(screen.getByRole('button',{name:'실행'})).toBeEnabled());
  expect(screen.queryByText('후보 B 원문')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'원문 불러오기'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('질문'),{target:{value:'공개 질문'}});
  fireEvent.click(screen.getByRole('button',{name:'실행'}));
  expect(await screen.findByText('게시 A 검색 결과')).toBeInTheDocument();
});

it.each(['hash', 'job'])('원문을 읽는 동안 분석 %s가 바뀌면 원문을 표시하지 않는다', async change => {
  vi.stubEnv('DEV', true);
  const doc='00000000-0000-0000-0000-000000000001', a='00000000-0000-0000-0000-000000000002', b='00000000-0000-0000-0000-000000000003';
  const current={job_id:a,state:'succeeded',processing_mode:'automatic',progress:{stored:1}};
  let loaded=false;
  const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  const fetchMock=vi.fn(async(url:string)=>{
    if(url.endsWith('/processing'))return json({ready:true});
    if(url.includes('/programs?'))return json({items:[],next_offset:null});
    if(url.includes('/jobs/'))return json(current);
    if(url.endsWith('/markdown')){loaded=true;return new Response('교체 전 원문',{status:200,headers:{'Content-Type':'text/plain'}});}
    return json({document_id:doc,name:'게시 문서',active_job_id:a,jobs:[current],analysis:{
      hash:loaded&&change==='hash'?'new-hash':'old-hash',job_id:loaded&&change==='job'?b:a,
      scope:'published',blockers:[],warnings:[],total_blocks:1,blocks:[],next_offset:null,
    }});
  });
  vi.stubGlobal('fetch',fetchMock);
  render(<MemoryRouter initialEntries={[`/admin/documents?document=${doc}&job=${a}`]}><App /></MemoryRouter>);
  await waitFor(()=>expect(screen.getByRole('button',{name:'원문 불러오기'})).toBeEnabled());
  fetchMock.mockClear();
  fireEvent.click(screen.getByRole('button',{name:'원문 불러오기'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('analysis_version_changed');
  expect(screen.queryByText('교체 전 원문')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'원문 불러오기'})).toBeEnabled();
  expect(fetchMock.mock.calls.map(([url])=>url.replace(/^.*\/documents/,''))).toEqual([
    '/'+doc+'?limit=1','/'+doc+'/markdown','/'+doc+'?limit=1',
  ]);
});

it('기존 게시 원문 재처리는 한 번 요청하고 반환된 새 작업으로 이동한다', async () => {
  vi.stubEnv('DEV', true);
  const doc='00000000-0000-0000-0000-000000000001', a='00000000-0000-0000-0000-000000000002', b='00000000-0000-0000-0000-000000000003';
  const current={job_id:a,state:'failed',processing_mode:'automatic',error_code:'failed'};
  const next={job_id:b,state:'queued',processing_mode:'automatic'};
  let retried=false;
  const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  const fetchMock=vi.fn(async(url:string,options?:RequestInit)=>{
    if(url.endsWith('/processing'))return json({ready:true});
    if(url.includes('/programs?'))return json({items:[],next_offset:null});
    if(url.endsWith('/retry')){expect(options?.method).toBe('POST');retried=true;return json({job_id:b});}
    if(url.includes('/jobs/'))return json(url.endsWith(b)?next:current);
    return json({document_id:doc,name:'기존 게시 문서',active_job_id:a,jobs:retried?[next,current]:[current]});
  });
  vi.stubGlobal('fetch',fetchMock);
  render(<MemoryRouter initialEntries={[`/admin/documents?document=${doc}&job=${a}`]}><App /><LocationProbe /></MemoryRouter>);
  await waitFor(()=>expect(screen.getByRole('button',{name:'기존 게시 원문 자동 재처리'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'기존 게시 원문 자동 재처리'}));
  expect(await screen.findByText('접수 완료 · 작업 대기')).toBeInTheDocument();
  expect(screen.getByTestId('location')).toHaveTextContent('job='+b);
  expect(fetchMock.mock.calls.filter(([url])=>url.endsWith('/retry'))).toHaveLength(1);
  expect(screen.getByRole('button',{name:'실행'})).toBeDisabled();
});

it.each(['leave','expire'])('상태 조회 중 %s 후 늦은 상태가 작업 화면을 복구하지 않는다', async stop => {
  vi.stubEnv('DEV',true);
  saveAdminSession({access_token:'synthetic-token',session_id:'synthetic-session',expires_at:Math.floor(Date.now()/1000)+600});
  const doc='00000000-0000-0000-0000-000000000001', job='00000000-0000-0000-0000-000000000002';
  let finish!:(value:Response)=>void, signal:AbortSignal|undefined;
  const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{
    if(url.endsWith('/processing'))return json({ready:true});
    if(url.includes('/programs?'))return json({items:[],next_offset:null});
    if(url.includes(doc+'?limit=1')){signal=options.signal as AbortSignal;return new Promise<Response>(resolve=>{finish=resolve;});}
    throw new Error('unexpected request');
  }));
  const view=render(<MemoryRouter initialEntries={[`/admin/documents?document=${doc}&job=${job}`]}><App /></MemoryRouter>);
  await waitFor(()=>expect(signal).toBeDefined());
  if(stop==='leave')view.unmount();
  else {checkAdminAccess.mockRejectedValue(new ApiError('expired',401));act(()=>clearAdminSession('synthetic-session'));await screen.findByLabelText('비밀번호');}
  expect(signal?.aborted).toBe(true);
  await act(async()=>finish(json({document_id:doc,name:'늦은 상태 문서',active_job_id:job,jobs:[{job_id:job,state:'succeeded'}]})));
  expect(screen.queryByText('늦은 상태 문서')).not.toBeInTheDocument();
  expect(screen.queryByRole('region',{name:'검색 결과'})).not.toBeInTheDocument();
});
