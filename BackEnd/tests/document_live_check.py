"""사용자가 실행하는 로컬 Swagger 보조 도구다. DDL·DB 직접 쓰기·서비스 기동은 하지 않는다."""

import argparse
import json
from pathlib import Path
import time
from urllib.parse import urlsplit
from uuid import UUID

import httpx

PREFIX = '/api/v1/admin/documents'


def poll(client, document_id, job_id, expected, timeout):
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        response = client.get(f'{PREFIX}/{document_id}')
        response.raise_for_status()
        state = response.json()
        job = next((j for j in state['jobs'] if str(j['job_id']) == str(job_id)),None)
        if not job:
            raise RuntimeError('작업이 삭제·교체되었습니다. 현재 문서 상태를 확인하세요.')
        if job['state'] in ('failed','cancelled'):
            raise RuntimeError('문서 작업 종료: '+str(job.get('error_code') or job['state']))
        if job['state']==expected:
            return state
        time.sleep(2)
    raise RuntimeError('대기 시간 초과입니다. 서버 작업은 취소하지 않았으며 Swagger에서 상태를 확인하세요.')


def main():
    parser = argparse.ArgumentParser(description='이미 실행 중인 루프백 Swagger의 TEST_ 문서만 다룹니다.')
    parser.add_argument('--base-url',default='http://127.0.0.1:8000')
    parser.add_argument('--fixture',type=Path)
    parser.add_argument('--metadata',type=Path,help='사용자가 검토한 DocumentMetadata JSON. 신규 업로드에서 필수입니다.')
    parser.add_argument('--document-id',type=UUID,help='기존 테스트 문서면 업로드를 생략합니다.')
    parser.add_argument('--review',type=Path,help='모든 블록을 읽고 사용자가 작성한 IndexRequest JSON입니다.')
    parser.add_argument('--query',action='append',default=[],help='게시 후 문서 전용 RAG 질의. 실제 모델이 실행됩니다.')
    parser.add_argument('--result',type=Path,required=True,help='원문을 포함할 수 있으므로 저장소 밖 파일을 지정하세요.')
    parser.add_argument('--timeout',type=int,default=7200)
    args = parser.parse_args()
    url = urlsplit(args.base_url)
    if (url.scheme!='http' or url.hostname not in ('localhost','127.0.0.1','::1')
            or url.username or url.password or url.path not in ('','/') or url.query or url.fragment):
        parser.error('인증정보 없는 HTTP 루프백 주소만 사용합니다.')
    root = Path(__file__).resolve().parents[2]
    result_path = args.result.resolve()
    if result_path.is_relative_to(root):
        parser.error('--result는 저장소 밖 경로여야 합니다.')
    if not 1<=args.timeout<=86400:
        parser.error('--timeout은 1~86400초입니다.')
    if not args.document_id and (not args.fixture or not args.metadata):
        parser.error('신규 업로드에는 --fixture와 --metadata가 필요합니다.')

    # OS 프록시나 외부 리다이렉트를 따라가서 테스트 원문을 외부로 보내지 않는다.
    with httpx.Client(base_url=args.base_url.rstrip('/'),timeout=120,follow_redirects=False,trust_env=False) as client:
        document_id = str(args.document_id) if args.document_id else None
        if document_id:
            response = client.get(f'{PREFIX}/{document_id}')
            response.raise_for_status()
            state = response.json()
            if not state['test_only']:
                parser.error('실제 문서는 이 도구의 대상이 아닙니다.')
        else:
            metadata = json.loads(args.metadata.read_text(encoding='utf-8-sig'))
            if metadata.get('test_only') is not True or not str(metadata.get('service_id','')).startswith('TEST_'):
                parser.error('test_only=true인 TEST_ 제도만 지정합니다.')
            response = client.get(f'{PREFIX}/programs',params={'test_only':'true','limit':200})
            response.raise_for_status()
            programs = response.json()['items']
            if not any(p['service_id']==metadata['service_id'] and p['test_only'] for p in programs):
                parser.error('해당 TEST_ 제도를 SQL로 먼저 등록해야 합니다. 이 도구는 제도를 만들지 않습니다.')
            with args.fixture.open('rb') as stream:
                response = client.post(PREFIX,files={'file':(args.fixture.name,stream)},
                                       data={'metadata':json.dumps(metadata,ensure_ascii=False)})
            response.raise_for_status()
            uploaded = response.json()
            document_id, job_id = uploaded['document_id'], uploaded['job_id']
            state = poll(client,document_id,job_id,'awaiting_review',args.timeout)

        if args.review:
            review = json.loads(args.review.read_text(encoding='utf-8-sig'))
            response = client.post(f'{PREFIX}/{document_id}/index',json=review)
            response.raise_for_status()
            state = poll(client,document_id,response.json()['job_id'],'succeeded',args.timeout)

        output = {'document_id':document_id,'status':state,'runtime_verified':False,'answers':[]}
        if args.query and not state['active_job_id']:
            parser.error('게시 전입니다. 먼저 모든 블록을 검토하고 --review로 index를 승인하세요.')
        for question in args.query:
            response = client.post(f'{PREFIX}/{document_id}/query',json={'query':question})
            response.raise_for_status()
            output['answers'].append(response.json())
        # 선택 원문·단위·조건·예외·보류 여부를 사람이 확인해야 하며 HTTP 200을 합격으로 표시하지 않는다.
        output['interpretation'] = '요청 결과 수집입니다. 추론 정확도 판정과 자동 합격 처리는 하지 않았습니다.'
        result_path.parent.mkdir(parents=True,exist_ok=True)
        result_path.write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
        print('document_id='+document_id)
        print('자동 검토·자동 합격 판정 없이 결과를 저장했습니다.')


if __name__=='__main__':
    main()
