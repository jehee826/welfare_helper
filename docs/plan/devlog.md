# 개발일지

작성: 2026-11-09. 최신 업데이트: 2026-11-09 16:35 KST

현재 작업은 [인계](handoff.md), 요구사항·완료 기준은 [실행 계획](merge_plan.md)을 따른다. 아래 기록은 실제 수행한 변경·실패·검증만 날짜별로 누적하며 과거 실패를 수정 후 성공으로 덮지 않는다.

## 2026-11-09 · EC2 최신화와 정확도 재확인

- 로컬 `docs/log/development.md`·`handoff.md`와 빈 폴더를 사용자 요청으로 삭제했다. Git 제외 파일이라 삭제 커밋은 없고 EC2에는 같은 폴더가 없었다.
- EC2 `/home/ubuntu/welfare_helper`의 `codex/fix-merge`·clean 상태를 확인하고 GitHub 직접 `pull --ff-only`로 `02317bb`→`0bb9f27`을 반영했다. 인계·원문 자료 공유2커밋이며 제품 코드 변경은 없었다. 서비스 재시작·이미지 교체·DB 쓰기·모델 변경은 없었다.
- 과거 시험 원자료가 두 기기의 지정 위치에 없어 새 합성 질문1건으로 아동수당을 확인했다. 만3세·국적 미확인 조건에서 지급일/신청자격을 물었고, timeout180초·내부HTTP·25.391초·200·answer였다.
- 내용 실패: 근거 문서에는 지급일이 없지만 “매월10일경 지급”을 생성했다. 국적 미확인에 대해서는 자격 판단을 보류했다. HTTP200과 응답 시간으로 정확도 통과를 주장하지 않는다.
- 근거 document는 `c1c98d43-b845-486e-ad13-8ce26541170a`, 원자료는 EC2 Git 제외 `.local/co-op/checks-runtime/resume-20261109-child/`다. 입력·원문·첫응답·시간·이미지·SHA·원문해시를 보존했다. 같은 질문 재시도는 없었다.
- 위 결과를 `merge_plan.md`에 기록한 EC2 로컬 커밋은 `33cf3d8`이며 당시 미push였다. 실제 실행 backend는 기존 `07de146d…` 이미지였다. 제품 코드 보완은 아직 수행하지 않았다.

## 2026-11-09 · 개발·설계 역할 재개와 기록 정리

- `캡스톤-개발`에 기존 계획·EC2 상태·단건 실패 원자료·검토 경계를 전달했고 연결 도구에서 active 상태를 확인했다. 개발 담당은 EC2 `33cf3d8`·clean 상태와 첫 응답을 직접 확인했다고 보고했다. 초기 범위는 `BackEnd/documents/context.py`와 필요한 기존 검사이며 후보 구현·집중검사 결과는 아직 수신하지 않았다. 활동 상태를 구현 완료로 취급하지 않는다.
- 개발은 EC2 변경을 기준으로 수행하고 설계는 읽기 검토·중간 설계·감시를 맡는다. push·로컬 pull 이전에 로컬에 보이지 않는 변경을 누락으로 판단하거나 로컬본으로 덮지 않는다.
- `docs/plan/handoff.md`·`devlog.md`를 생성하고 현재 인계와 오늘 실제 경과를 기록했다. 프로젝트 기록 지침·문서 목차·Git 공유 예외를 이 두 파일에 맞춘다. 기록 작성자는 설계로 유지하고 개발 담당은 단계 결과를 전달한다.
- 다음: 개발의 근거 부족 처리 후보·집중검사 결과를 검토하고 인계와 이 일지를 갱신한다. 새 실제 추론·배포·DB 변경을 이번 문서 작업으로 수행하지 않는다.

## 2026-11-09 12:00 KST · EC2 기록 반영과 후보 읽기 검토

- 사용자가 공유 인계·일지를 EC2에도 반영하도록 지시했다. EC2의 기존 기록 커밋33cf3d8을 SSH Git fetch로 받아 로컬 기능 브랜치를 fast-forward했다. bundle·소스 덮어쓰기는 사용하지 않았다.
- 개발 담당과 Git/index 조작을 잠시 직렬화했고, EC2의 미커밋 context.py는 보존한다. 공유 문서·지침7파일만 선별해 GitHub를 거쳐 EC2에 반영하는 절차를 진행한다.
- 설계가 실제 EC2 context.py diff(+4/-1)를 읽었다. 질문항목별 원문대조, 일부 근거/미확인 구분, 다른 수치·일반지식으로 보충 금지의 일반 지침이다. 문항별 특례·API/저장계약·검색/prepare 변경은 없었다. 상태 분류의 clarify/out_of_scope 경계를 유지하는지 추가 검토하고 검사 결과를 기다린다.
- 개발 보고상 기존 검사 환경을 확인 중이며, 이 단계의 실제 모델 호출·서비스 변경·DB 쓰기는0이다. 프롬프트 수정만으로 정확도 결함이 해결됐다고 판정하지 않는다.

## 2026-11-09 12:11 KST · 문서 동기화 완료와 첫 후보 실패

- 문서33cf3d8·75b5f72 push는 최초 자동 심사에서 이번 브랜치/커밋의 명시 승인 부족으로 거절됐다. 우회하지 않고 사용자 승인 후 같은 범위로 push해 성공했다. GitHub·로컬·EC2를75b5f72로 맞췄고 handoff/devlog blob 일치와 미커밋 context.py 해시 보존을 확인했다. 서비스 재시작·이미지/DB 변경은 없었다.
- 개발 담당은 pytest가 없는 기존 환경에서 외부 임시 패키지 설치를 시도했으나 자동 심사 거절로 실행되지 않았다. 우회하지 않고 기존이미지 Python3.12·네트워크 차단·읽기전용·운영환경파일 없는 격리 stdlib unittest/mock검사로 전환했다. prepare 프로필 분리/직접 원문, final ON/OFF와 source불변, assistant/summary 비근거, 주제전환/reset, 입력예산 미호출5개 통과 보고를 받았다. pytest 회귀 통과로 표시하지 않는다.
- a9747c97… 후보의 실제 최종생성 missing_item1회는13.262초·HTTP200·유효JSON·done_reason stop이었다. 실제입력2128/출력264토큰이며 운영모델/옵션을 유지했다. 하지만 C1/C2를 인용하면서 '매월10일'을 생성했고 질문 밖 신청경로와 '국적 확인 후 신청 가능'을 보충했다. 설계가 입력·schema·첫출력·메타데이터를 직접 읽고 내용 실패를 확인했다. 서비스의 이미지/시작시각 불변도 원자료에서 확인했다.
- 후보는 보존 HTTP response의2근거로 재구성한 최종생성 입력이다. 정답표/기대답변은 입력에 넣지 않았고 source_ids enum C1/C2·ctx16384·출력1024·temperature0·threads8·180초로 고정했다. 원자료는 EC2 `.local/co-op/checks-runtime/resume-20261109-grounding/missing_item-{input.json,stdout.json,stderr.log,metadata.json}`에 보존했다. 전체 검색/HTTP/Chrome 회귀 성공으로 확대하지 않는다.
- 호출수 정정: 마지막 상태문구 정정을 전달할 때 담당 보고는0회였으나 실제1회가 이미 시작된 상태였다. 호출 중 제품/runner를 바꾸지 않았고 추가 재시도도 하지 않았다. 실행된 a9747c97…와 아직 실행하지 않은 마지막 문구 정정을 구분한다.
- 설계는 핵심 결함 재현으로 후보를 실패 판정하고 남은1회는 보류했다. 제품커밋/배포0을 유지하며, 추가추론·프롬프트 반복추가 없이 실제 입력구조와 source_ids 검증 범위를 읽기 분석하도록 개발에 전달했다. 이 절의 후속 기록은 로컬 작성본이며 다음 Git 동기화 대상이다.

## 2026-11-09 12:29 KST · 내부 출력 구조 중간 설계

- 개발의 비교안을 검토했다. 기존 text를 유지하며 항목별 메모도 출력하는 A안은 설명 중복과 항목/최종text 불일치가 남는다. B안은 항목별 설명만 출력하고 서버가 그대로 연결하므로 별도 자유서술 단계와 중복 출력을 줄일 수 있다. 두 안 모두 의미 정확도를 보장하지 않으며 출력1024 안에서 발췌/설명 비용이 남는다.
- B안을 다음 후보 구현·모델 없는 검사 범위로 전달했다. 내부 전역status/source_ids·연락처모드contact_ids와 항목별 근거/미확인·설명을 받아 기존 WelfareAnswer/ContactSelectionAnswer로 정규화한다. extra=forbid 소비자에는 새 필드를 흘리지 않는다. 참조·문서버전·필드/길이만 기술 검증하고 의미별 문장 삭제/재작성·발췌공란에 따른 상태판정을 하지 않는다. 인용일치 게이트는 복원하지 않는다.
- 공개API/저장/클라이언트·검색/prepare·프로필/취소/기한은 유지한다. 예산초과/잘린JSON/누락필드는 명시 실패로 처리하고 절단·추가호출·조용한 항목누락으로 맞추지 않는다. 합성 검사 성공을 의미정확도 성공으로 보지 않는다.
- 다음은 context/welfare/qa와 필요한contacts 소비자·관련 검사에 대한 구현/diff/실제 내부schema/검사보고다. 새 실제모델 호출·배포·제품커밋은 아직 보류하며 원격75b5f72와 로컬 후속기록 이력을 확인해 Git 반영을 직렬화한다. 설계 기록 변경은 현재 로컬 작성본이다.

## 2026-11-09 12:41 KST · B안 1차 검토와 불완전 JSON 경계

- EC2 제품 context/welfare/qa/contacts4파일·관련 기존 검사5파일의 미커밋1차를 설계가 읽었다. 내부 항목을 연결해 기존 엄격 응답 모델로 정규화하고 참조/연락처 선택 검사를 재사용한다. 발췌는 형식만 검사하며 의미/원문일치 게이트는 추가하지 않았다.
- 항목명1000·발췌500·설명 개별/총3000자, 근거목록각6·항목최소1이며 임의 항목수 상한은 없다. 조립 구분줄도 총3000자에 포함해 검사하고 초과 시 절단하지 않는다. 발췌/설명은 기존 출력1024를 함께 사용하므로 무손실 수용이나 의미개선을 보장하지 않는다.
- 모델 출력순서는 항목근거를 전역판단 전에 생성하도록 items→status→source_ids로 정리했다. 정확도 효과는 아직 검증하지 않았다. 개발 보고의 모델없는11개 검사(정규화5+QA6)는 통과했으며 최초 source_url 중복전달 대역 오류는 수정 후 해당 QA만 확인했다. 원래 실패 출력은 보존했고 pytest는 미실행이다.
- 기존 OllamaClient.chat의 JsonOutputParser가 부분JSON을 복구할 수 있어 닫힘만 잘린JSON의 명시 실패 조건이 미완료임을 개발이 보고했다. 설계가 실제274~316행을 읽고 최종생성에만 strict JSON 선택을 추가하도록 rag/ollama.py·기존 test_ollama.py 범위를 허용했다. 기본 parser/다른소비자·예산/length/truncated/취소/기한은 유지한다. 정상JSON·stop인데잘린JSON·추가호출0·최종생성만선택되는 경계를 확인한다.
- 추가 모델호출·운영/DB 변경·제품커밋은0이며 내부 원자료는 EC2 `.local/co-op/checks-runtime/resume-20261109-items/`에 보존한다. 다음은 strict 파싱 포함 최종 diff와 모델 없는 검사 결과 검토다. 이 후속 기록은 로컬 작성본으로 다음 Git 동기화 대상이다.

## 2026-11-09 12:47 KST · strict 파싱 검토와 검사 근거 불일치

- 최종 미커밋은 제품5파일·기존 검사6파일, 총11파일이다. 설계가 ollama.py의 strict_json 기본False와True에서만json.loads를 쓰는 최소 diff를 확인했다. 기존 length/truncated·기한/취소·진단은 유지했고 최종QA만True를 사용한다. strict_json_check.log의7개 성공과 실제 QA generation_failed 전달을 원출력으로 확인했다.
- 개발 최종보고는 정규화5+QA6+strict7의고유18검사, 별도schema1검사/3변형이다. 그러나 설계가읽은 stdlib_items_check-first.log와stdlib_items_check.log는둘다11오류였고 second.log만QA6개 성공이었다. 따라서 정규화5개가최초에성공했다는보고의원출력근거를추가요청했다. 이시점보고18개전체를확정통과로표현하지않는다.
- 기존성공출력이있으면위치를보존해전달하고, 없거나미실행이면해당5개만최종코드에서확인해새로그로남기도록요청했다. 옛실패로그는덮지않고전체11검사반복을기본으로하지않는다. pytest미실행·B안실제모델0·운영/DB/제품커밋0을유지한다.

## 2026-11-09 12:49 KST · 검사 근거 정정과 B안 최소평가 준비

- 정규화성공은별도로그가아닌최초실패실행내개별ok행에있었다. 설계가first.log5/13/14/16/18행을직접확인했고, FAILED(errors=11)의11은QA6개내부subtest오류도포함해상위11개모두실패를뜻하지않음을정정했다. normalization-pass-evidence.json이원문행·전체실패요약·원본SHA를보존한다. 재시험은하지않았다.
- 단계별고유18개성공(최초정규화5·대역수정후QA6·추가strict7)과별도schema1개/3변형을수용했다. 최종스냅샷일괄18실행·pytest회귀·의미정확도성공으로확대하지않는다. 실제제품diff/strict파싱읽기검토에서현재차단결함은찾지못했다.
- B안최소평가는동일모델/옵션·보존2근거·새내부schema/정규화/strict파서로최종생성최대2회·각180초·문항별1회·재시도0으로정했다. 첫질문은보존된국적미확인3세아동의지급일/자격질문이며통과한때만둘째지원금액/해외체류중단기준질문을진행한다. 첫건기술/의미실패면남은호출은사용하지않는다.
- 새실행경합을막기위해최종후보·질문·근거·프롬프트/schema·옵션해시와호출0회준비보고후설계가시작을확인하고한담당만실행한다. 이시점추가모델호출은0이며운영서비스/설정·DB·검색/prepare·제품commit/push는변경하지않는다. 후속설계기록은로컬작성본이다.

## 2026-11-09 13:01 KST · B안 입력 고정과 실행 심사 거절

- 개발이 동일후보·질문2개·보존근거2개·내부schema/옵션을 v2 manifest에 고정했다. 경로는 EC2 `.local/co-op/checks-runtime/resume-20261109-items-eval-v2/`, manifest SHA256은 a98e27db876331a375adf70736a3a635b3e3567cd9b8f920f92595e8c5a0103f다. v1은 보존하고 동결 모듈 자기해시 대조 누락을 보완했으며 준비 중 실제 생성은0이었다.
- 설계가 실제11파일·두runner·manifest 해시를 직접 읽기 확인했다. prepared.json raw 파일 SHA를 manifest의 canonical JSON SHA와 비교해 false를 얻었는데도 처음 시작 확인 메시지에 일치라고 잘못 적어 즉시 보류로 정정했다. runner와 같은 canonical 규칙으로 재계산한 da8f2648ed2b96d2e343446fd808dc61a2b44ae3d68902e61fec1964ecfa1e63이 일치함을 확인한 뒤 보류를 해제했다. 이 과정에서 후보·입력·manifest 변경이나 추가 생성은 없었다.
- 개발이 manifest·실행소유자·첫문항상한1·180초/재시도0을 묶은 실행시작 파일을 만들고 단일 담당에게 전달했다. 그러나 실제 실행명령은 자동 심사에서 EC2로 합성 질문·문서 입력을 전달하는 시험의 직접 사용자 승인 확인 부족으로 거절돼 실행되지 않았다. 실제 생성/SSH dispatch/attempt/시험프로세스는0이며 응답 파일도 없다. 우회·재시도·다른 실행담당 전환은 하지 않는다.
- `캡스톤-개발`에서 첫1회 범위의 승인 카드1개를 요청했다. 설계는 중복 질문을 만들지 않고 같은 manifest·한 담당·서비스/DB 변경0 범위를 유지하도록 전달했다. 첫 결과를 설계가 읽기 판정하기 전 둘째 문항은 금지한다. B안 실제모델 품질은 미검증이며 코드커밋·push·배포는 아직 보류다. 이 후속 기록은 로컬 작성본이다.

## 2026-11-09 13:07 KST · 직접 승인 후 B안 첫 평가도 의미 실패

- 개발 채팅에서 첫문항1회/180초/재시도0·EC2의보존합성질문/공개2근거→같은EC2기존Qwen·서비스/DB변경0의직접사용자승인을받았다. 설계도연결도구의실제human응답을확인했다. 같은manifest/기존시작파일/단일실행담당을유지했고새입력/모델설정은없었다.
- 실제최종생성1회·16.355초·generationHTTP200·done_reason stop·prompt_eval2295/eval413이었다. strictJSON·Pydantic·참조합집합·총3000자정규화는통과했고추가검색/prepare/embed/DB호출0·재시도0·후보11파일해시와4서비스ID/이미지/시작시각불변이다. 시험프로세스잔여없음을개발이확인했다. 전체HTTP/Chrome지연이나품질로확대하지않는다.
- 의미실패: 지급일항목이C1나이요건을발췌하고‘만3세는만9세미만이므로지급대상’이라고답했다. 없는날짜를생성하지는않았지만지급일미확인을말하지않고질문항목을바꿔답했다. 신청자격설명은국적미확인을언급한뒤국적·난민·특별기여자·주민등록요건을OR충분조건처럼나열했고발췌에있던난민심사진행중제외도설명에서누락했다. 부분충족과최종자격의구분이유지되지않았다.
- 실제JSON의항목키순서는evidence/explanation/item이었다. 선언순서와다르다는관측은남기되이차이가실패원인이라고단정하지않는다. 참조C1과발췌문구가유효해도요청항목/설명과의의미대응은보증하지못함을확인했다. 서버는설명을그대로연결했으며문장을삭제/수정하지않았다.
- 설계가raw/items·정규화/진단·수동review를직접읽고실패판정을수용했다. 원자료경로는 EC2 `.local/co-op/checks-runtime/resume-20261109-items-eval-v2/`, 응답SHA256은 cc9cb32146022c860e29f8c009d5ca6f8b9bdd8cfc8a68c37913419f77b0cca2다. missing_item-attempt파일1개, supported_items/pass파일없음도확인했다.
- 정해진중단조건에따라둘째평가는미사용이다. 제품commit/push/배포/재시작0을유지하고미커밋11파일/원자료를보존한다. 추가후보작성/재시도없이중간설계범위를다시정리하도록개발에전달했다. 이후속기록은로컬작성본이며다음Git동기화대상이다.

## 2026-11-09 13:34 KST · 전체 잔여 작업과 사용자 확인 계획 통합

- 연결된 개발 채팅의 검증 종료/대기와 로컬clean·HEAD2f2ef68/문서5커밋선행을 확인했다. EC2 SSH 읽기로 HEAD75b5f72·제품5/검사6미커밋, GitHub fix-merge75b5f72/main eb760b6을 재확인했다. 새 추론·시험·서비스/DB 변경·push/pull은 수행하지 않았다.
- 기존 merge_plan 5.1절에 Git 문서 동기화/실패 후보 보존→정확도 설계/검증→확장 시험→자료/관리자 운영→최종CI/PR/복구·로컬 전환 순서를 작성했다. 사용자 직접 확인은 U1~U8로 묶고 전송 데이터/7일/권한/서버 수명 검사는 개발 담당으로 분리했다. 실제 CSV·사용자 인증·청취·범위별 운영 승인·사용자 PR 생성의 요청 시점과 완료 기준을 적었다.
- 저장소의 GPU/모델 환경 전환과 HTTPS 전용 확장까지 완전 로컬로 바꾸는 작업을 구분했다. 시연3개/기존364개 자료를 재요구·재적재하지 않으며 W14 OFF/W15 미전환·Caddy/서비스 유지·후속 웹 제작 제외를 보존했다.
- merge_plan의 오래된 PR 생성 주체를 현재 지침의 사용자 생성으로 정정하고 현재 상태를 handoff에 연결했다. 이전 실패 이력은 유지했다. 문서3파일만 선별 확인·커밋 대상이며 후속 push/EC2 동기화는 정확한 범위를 제시한 뒤 수행한다.

## 2026-11-09 14:06 KST · RAG 보류와 비RAG 개발 재개 범위

- RAG 정확도와 후속 추론은 보류하고 사용자 직접 확인을 제외한 개발/수정을 재개하는 것으로 현재 우선순위를 변경했다. 기존 실패 후보11파일/원자료는 보존한다.
- 비RAG 첫 범위는 확장 저장/7일/OFF·취소/늦은 응답·UI 설정/모달·DOM/음성 수명·관리자 오류/권한의 기존 자동 검사와 남은 공백 대조, 격리 검사와 발견 결함의 최소 수정이다. 전체 통과 검사 반복·실제 모델 호출·운영DB/서비스/인증 변경은 이 단계에 포함하지 않는다.
- 제품 작성/시험은 기존 캡스톤-개발에 재배정하고 설계는 검토/기록을 유지한다. 문서 선행 커밋이 있으므로 제품 커밋 전 동기화 순서를 조율한다. CSV·실제 Chrome/청취·사용자 인증에 의존하는 항목은 대기로 구분하며 독립 작업을 먼저 진행한다.

## 2026-11-09 14:11 KST · SSH 접근 장애와 독립 검토 유지

- 개발이 EC2 SSH15초timeout/원격명령시작0을 보고했다. 설계의 권한 있는TCP읽기확인은15.164.190.21:22 timeout/:443 connected였다. 샌드박스 내 첫실패와 구분한 결과이며 서버 전체 중단·보안그룹·sshd 원인은 미확정이다. HTTPS연결을 상담/모델 정상으로 확대하지 않는다.
- 연결된 AWS관리도구/CLI가 없어 내부 네트워크설정은 확인하지 못했다. 개발에는SSH재시도중단·로컬제품읽기/기존검사공백대조계속·로컬구현전환금지를 전달했다. 원격제품수정/모델호출/운영설정변경은0이며EC2미커밋11파일의현재상태는재확인하지못했다.

## 2026-11-09 14:16 KST · 관리자 조회 상태 결함 재현 검토

- 개발의 로컬 대역렌더와 설계의소스/원로그읽기로 DocumentsPage의조회실패와미설정/빈목록혼동,재조회실패후기존목록으로업로드활성화결함을확인했다. processing-defects-first.log는3실패/1성공(ready=false대조),processing-additional.log는추가2실패/1성공/기존4skip이다. 앞실패로미도달한빈목록안내를분리확인했고성공재조회회복은성공했다. 이는실제Chrome/EC2검사가아니다.
- 원자료는로컬 .local/co-op/checks-runtime/nonrag-20261109/다. 최초Vitest수집실패로그는보존하고경로수정후제품결함재현과구분했다. Node24.14.0은계획Node22와다르며새의존성설치/외부API/모델호출/제품변경은0이다.
- 최소수정은prepared미확인상태와현재목록조회완료를분리하고설정/목록이모두확인된때만업로드버튼및submit을허용한다. 오류문자열전체로가드해업로드오류후재시도까지막지않는다. DocumentsPage.tsx/기존DocumentsPage.test.tsx범위이며RAG11파일과겹치지않는다. 실제제품수정은SSH복구후EC2에서수행한다.

## 2026-11-09 14:18 KST · 배포 문서 병렬 수 정정

- 개발이 찾은 deploy/README의병렬3설명과docker-compose.yml의실제병렬1을설계가직접대조했다. 배포문서만병렬1/대기3·앱gate3과구분하고동시3생성/직렬처리실패라는옛판정기준을현단건30→50→60초기준으로정정했다. 과거T4병렬3의모델축출관측은과거사실로보존했다.
- 실행설정/서비스/모델/DB변경과추론은0이다. 문서구문/상대링크와diff공백만확인하며새운영실측으로표현하지않는다. W14/W15의기본값/복구절차읽기확인을실제활성화/런타임확인으로확대하지않는다.

## 2026-11-09 14:21 KST · worker 자연 종료 정리 경합 검토

- 개발의stdlib대역재현과설계의원본worker.py/시험스크립트/원로그읽기로poll후TERM직전및wait timeout후KILL직전의자연종료가ProcessLookupError로전파되는두경로를확인했다. supervise의예외정리에서이오류가나면store.fail호출도막을수있다. 실제운영발생으로단정하지않는다.
- 원본stop_child함수AST만추출하고가짜os.killpg/상수/child로실행했다. Python3.12.13이며실제PID/신호/외부API/모델/DB호출0이다. 최초Windows SIGKILL상수부재의대역오류는보존했고수정대역에서3메서드중1성공/경합2오류,추가대조2메서드성공을확인했다. 정상TERM/wait·timeout→KILL/wait와PermissionError전파가대조에포함된다.
- 원자료는기존 nonrag-20261109/stop_child_race.py·stop_child_race-first.log·stop_child_race.log·stop_child_controls.log다. worker.py SHA256은4ac3216e601f3b785a98e4f15349e5c047f1f3b0b78afe15fd67a7b397ab6bdb다. 제품원본/기존검사는변경하지않았고재현을종료했다.
- SSH복구후최소수정계약은worker.stop_child와관련기존검사에서ProcessLookupError경합만흡수하고경합후wait/reap을명시단언하며무관권한오류는유지하는것이다. Docling실제자식종료/메모리회수·운영복구는미검증이다. 관리자로드상태수정과함께우선대기로기록한다.

## 2026-11-09 14:31 KST · SSH 복구 확인과 두 수정 재개

- 접속정상확인후설계가동일15.164.190.21:22/기존키/엄격호스트확인으로읽기1회접속에성공했다. EC2 HEAD75b5f72·codex/fix-merge와RAG미커밋11파일목록을확인했다. 네트워크장애원인/내부설정변경은확인하지않았다.
- 관리자DocumentsPage조회상태·업로드가드,worker.stop_child자연종료경합을기존개발담당이EC2에서최소수정·관련검사하는단계로재개한다. RAG11파일과겹치지않는범위이며실제추론/서비스재시작/운영DB·인증변경은없다. 제품커밋전문서선행이력과동기화순서를맞춘다.

## 2026-11-09 14:43 KST · 비RAG 두 수정과 관련 검사 수용

- EC2의DocumentsPage.tsx·DocumentsPage.test.tsx·worker.py·test_document_automatic_pipeline.py4파일수정을설계가직접diff리뷰했다. 관리자prepared미확인/false/true와목록확인완료를구분해button/submit을같은canUpload로제한하고오류/빈목록오안내를수정했다. worker는TERM/KILL의ProcessLookupError만흡수하고wait/reap및무관오류전파를보존했다.
- 프런트는EC2원본2파일의rawSHA일치스냅샷을Vite load overlay로주입해기존DocumentsPage검사13개(기존8/추가5)통과·타입진단0을확인했다. 설계가OVERLAY경로/해시/실제13성공및진단0로그를읽고원격4파일rawSHA를별도로재계산해보고값과대조했다. 기존Node24.14.0/Vitest2.1.8이며Node22/최종CI/실제Chrome통과로확대하지않는다. 최초타입검사도구cwd불일치588진단은원로그보존후도구cwd만고쳐해결했다.
- worker는EC2기존Python3.12이미지의network-none/read-only/소스readonly격리에서수정함수와기존검사클래스AST를실행해6개통과했다. 설계도원로그를직접읽었다. pytest전체/실제Docling자식/메모리회수는미실행이다. Python문법/diff공백검사는통과보고이며실제PID신호0이다.
- 원자료는로컬 nonrag-fixed-20261109/{overlay-test.log,typecheck-overlay.log,두소스스냅샷과검사도구},EC2동명폴더/{worker_ast_check.py,worker_ast_check.log}다. EC2 nonrag-fixes-20261109/postflight.json의HEAD75b5f72·rag11_unchanged=true·model_calls/db_calls/service_changes_by_this_task/git_mutations=0을설계가직접읽었다. 현재컨테이너시작시각은과거RAG평가와달라전후불변을주장하지않으며이번검사직전스냅샷도없다.
- 두수정을수용하고추가전체검사는반복하지않는다. EC2미커밋15파일(RAG11+이번4),운영이미지미반영/제품Git작업0이다. 다음은로컬선행문서범위의승인된push→EC2보존확인ff-only동기화후이번4파일만선별커밋하는것이다. 실제배포/재시작·제품push는별도범위를확인한다.

## 2026-11-09 14:51 KST · 문서 동기화와 비RAG 선별 커밋 완료

- 로컬문서13커밋75b5f72..b450b83(문서5파일)을GitHub기능브랜치에push한뒤EC2에pull--ff-only했다. 전후15미커밋파일SHA전부동일·index빈상태·양쪽문서5blob일치를설계가확인했다. bundle/소스복사/서비스변경은없었다.
- 개발이EC2에서246b860544faee356660074b657cb72d85f908a7(문서등록조회실패업로드차단:DocumentsPage.tsx/검사2파일),1574e661d05226f3ed3631a209bcad6f80203491(자식종료경합:worker.py/automatic_pipeline검사2파일)로분리커밋했다. 실제각커밋범위와빈index·잔여RAG11만미커밋인상태를설계가SSH읽기로확인했다. 기존검증완료4파일해시와RAG11고정해시유지는개발기록commits.json에보존됐다.
- 설계가Git SSH fetch로EC2의2커밋을받아로컬codex/fix-merge를b450b83→1574e66으로ff-only동기화했다. 로컬제품편집/이력재작성은하지않았다. 제품2커밋은GitHub미push이며운영이미지/모델/DB는변경하지않았다. 다음은정확한제품2커밋·후속공유기록범위의push승인및EC2기록동기화다.

## 2026-11-09 14:59 KST · 수정 3커밋 원격 반영과 최신 CI 성공

- b450b83..a3e9299의승인된3커밋(관리자/worker수정4파일·공유기록2파일)을GitHub codex/fix-merge에push했다. EC2는이미제품2커밋이있어기록2파일만1574e66→a3e9299로ff-only반영했다. RAG11파일SHA전후동일·빈index·기록2blob의양쪽일치를설계가직접확인했다. main·서비스/이미지·모델·DB변경은없었다.
- 연결GitHub의범용fetch GET으로실제push run42570100926을찾아4jobs(python dev/backend/worker,web-extension)전체completed/success를확인했다. PR전용workflow조회/combined-status만으로Actions결과를대체하지않았다. 기존자연push실행을읽기감시했고새CI실행/재실행은0이다.
- dev원로그에서Node22.23.4·666passed/13skipped/2subtestspassed를확인했다. web-extension원로그는프런트13파일/120개통과·tsc/build성공·확장499pass/fail0이다. 이전Node24overlay와PythonAST집중검사는당시근거로보존하고현재커밋의정식CI성공과구분한다. 이결과는EC2미커밋RAG후보11파일을포함하지않는다.
- Vercel welfare-helper 상태success도확인했으나실제관리자API/업로드성공을뜻하지않는다. EC2실행이미지는제품수정을아직포함하지않으며실제Chrome·Docling자원수명/운영복구·W14/W15전환/RAG정확도는미완료다. 개발은남은독립비RAG공백대조를이어가고설계는결과를검토한다. 기록은후속로컬문서로다음동기화대상이다.

## 2026-11-09 15:07 KST · 운영 HTTPS 경계와 기능 준비 읽기 검토

- 기존EC2 HTTPS에서모델없는읽기4건을각1회수행한원자료를설계가직접읽었다. 15:01:30~31KST의표준TLS검증성공,공개chat/capabilities200(profile지원true/referralfalse),무자격admin/documents/processing401,허용관리자origin https://welfare-helper-iota.vercel.app 의OPTIONS200/ACAO정확일치/credentials헤더없음,거절origin400/ACAO없음을확인했다. 허용methods는GET/POST/PUT/PATCH/DELETE다. 자격증명/쿠키/로그인/chat POST/상담본문/모델/DB쓰기0이다.
- 원자료는로컬 nonrag-http-20261109/{http_check.py,inputs.json,results.json,command.txt}다. 첫결과에는Access-Control-Allow-Headers를기록하지않았으므로전체허용헤더실측으로주장하지않는다. content-type/authorization을요청하는허용preflight1회만보완하도록배정했고전체4건은반복하지않는다.
- EC2 nonrag-preflight-20261109/feature-image-readiness.json을설계가직접읽었다. backend/worker각각referral_records_enabled=false·credential_file_configured=false이며settings/referrals/referral_store/credentials/session5파일이이미지에존재하고LF정규화해시가committed기준과일치했다. backend의/app/.local/admin-credentials는RW볼륨이며worker에는현재미사용인인증볼륨이없다. 기존backend07de146d/workerba52ed0e이미지그대로다.
- 실제.env/키/비밀번호/인증파일본문/DB는읽지않았다. 기능준비를W14운영수집·실CSV매핑·W15초기화/비밀번호회전완료로확대하지않으며기존격리전체검사는반복하지않는다. 새코드결함/제품변경/서비스재시작은0이고보완후자동수행가능잔여와시작조건대기를분류한다.

## 2026-11-09 15:14 KST · CORS 헤더 보완과 다음 운영 시험 준비

- 15:09:37KST허용origin의OPTIONS1회보완원자료를설계가직접읽었다. 표준TLS성공·200/ACAO정확일치·ACAH Accept,Accept-Language,Authorization,Content-Language,Content-Type·ACAM GET/POST/PUT/PATCH/DELETE·credentials없음·Vary Origin/Access-Control-Request-Method/Access-Control-Request-Headers/Access-Control-Request-Private-Network를확인했다. 기존4건을덮거나반복하지않았고전체요청5건/실POST·로그인·모델·DB쓰기0이다. 원자료는기존nonrag-http-20261109/cors-headers-{check.py,result.json}이다.
- 개발이기존요구/검사근거와잔여를대조했고현재허용된무영향CI/계약/타입/정적/HTTPS범위에추가실패/제품결함은없다고보고했다. 실CSV/사용자실기기·청취·인증/운영전환·부하검증과RAG보류를남은시작조건으로분리하며기존통과검사를반복하지않는다.
- 다음A안은기존worker이미지의격리임시컨테이너로합성MD1개/최대64KiB를정상완료1회·취소관측1회(최대2자식/각180초/재시도0)확인하는하네스/manifest준비다. 제안자원은CPU1·메모리2GiB/총swap상한2GiB·pids128·tmpfs64MiB,호스트MemAvailable3GiB미만시시작거절이며network-none/readonly/기존cacheRO·신규다운로드0을준비조건으로둔다. 실제실행은미착수이며입력/committed함수해시/명령/관측/중단복구를검토가능하게만들도록배정했다.
- 설계가analysis.py를읽어PDF분기에만layout모델cache설정이있음을확인했다. MD시험은MD Docling자식수명까지만판정하며PDF모델메모리회수를대체하지않는다. parsing통지는convert직전이므로변환중취소의증거로단정하지않고이미종료된경우취소미관측으로종료한다. 취소타이밍을맞추기위한sleep/큰입력/반복은추가하지않는다. GPU취소/DBlease복구B/C는운영영향·격리/fixture범위미확정으로실행하지않는다.

## 2026-11-09 15:37 KST · Docling A 준비팩 v3 설계 읽기 검토

- Git제외기존docling-lifecycle-prep-20261109-v3/의manifest/명령/host runner/controller/child/readiness를설계가직접읽었다. 로컬과EC2각manifest SHA256 44b19c75734245972a1762fcbcad75c285dc15748464c100e260f395ecb7f33d·7artifact해시일치를확인했다. EC2execution-start.json/attempt.json/execution폴더모두없음을직접확인했으며컨테이너생성/변환/시험은아직0이다.
- 개발검토v1의비정상종료오판/정리실패미기록을v2에서고쳤고v3는env -i뒤WORKDIR/PYTHONPATH=/app을명시했다. 현재runner는소유CID/name/label/image를따로확인해자체컨테이너만정리하고attach종료코드/컨테이너exit·OOM/controller summary를대조한다. 누락/불일치·정리실패는실패,취소미관측/낮은메모리미착수는불완료다. 실제import성공은미검증이다.
- 고정worker이미지는ba52ed0e195d91fa74348806a62cb9238c7ced60de974a2b734557e959939a94,committed1574e66의stop_child함수SHA는57b76016017fff4f7a7758642dc3deac213ecfbab688f6e41480da148e7561f8,합성MD1213바이트다. 한임시컨테이너/최대2자식·정상1/취소관측1·각180초(170+종료유예10)·외부attach410초/정리별도timeout·재시도0을명령/판정과대조했다.
- 자원은CPU1/메모리2GiB·swap포함총2GiB/pids128/tmpfs64MiB,시작및각자식전MemAvailable3GiB하한이다. network-none/rootfsRO/기존Docling캐시RO만사용하며RAG작업트리/env/운영서비스·DB볼륨/모델은마운트하지않는다. 출력8MiB는감시중단값이며강제파일quota가아님을명시했다. 소유권미확인/미정리는CID/error/unresolved를보존한다.
- 추가수정요구없이준비팩을수용하고실제시험은범위확인전보류했다. 인위sleep/입력확대/반복없이parsing표시뒤취소를시도하고이미끝났으면불완료로종료한다. 판정은MD자식수명에한정하며PDF모델메모리회수/GPU/운영worker·DB복구를입증하지않는다. 실행시동일manifest해시와한실행담당을고정한다.

## 2026-11-09 15:42 KST · Docling A 고정본 실행 배정

- v3의한시실행범위를확인하고설계가시작직전EC2 manifest/7artifact전체일치·gate/attempt/execution없음·HEADa3e9299·빈index·RAG11rawSHA불변을직접읽었다. MemAvailable31643955200바이트로3GiB하한이상이었다. 이확인은변환/컨테이너실행이아니다.
- 기존개발담당과Terra단일실행자에게동일manifest44b19c75…의시작확인을전달했다. 한임시컨테이너·고정MD1213바이트·정상1/취소관측1·최대2자식각180초·재시도0이며runner/입력/설정변경은하지않는다. gate기록후기존execute명령1회만실행하고첫실패면후속사례를중단하도록했다. 현재결과미수신이며passed/incomplete/failed및자체정리/운영보존을근거로검토할예정이다.

## 2026-11-09 15:46 KST · Docling A 실행 결과 읽기 수용

- 동일v3 manifest44b19c75734245972a1762fcbcad75c285dc15748464c100e260f395ecb7f33d의gate/attempt기록후Terra단일담당이실행했다. 임시컨테이너는15:44:25~40KST동안기동됐고직접자식2개/재시도0이었다. 설계가execution-result.json/container-exit.json/execution/summary.json을직접읽어passed·attach0/컨테이너exit0·OOMfalse·errors없음을확인했다.
- 정상사례는10.771초·exit0·19블록·원문blockers없음·markdown1232바이트·자식peakRSS368784KiB였다. warning은unpaginated_source_use_block_anchors로MD쪽없음에대한원래안내다. 취소사례는parsing_marker_seen후SIGTERM/exit-15·4.315초로회수됐고두사례process_group_remaining은빈배열이었다. configured_model_calls/db_calls0이며실제변환중취소는두사례모두입증하지않는다.
- 자체CID7ea4331a18bd5f1302d1e3f5fff067efdb1e2c961a1b80463aa395824cbe038f의소유권확인/removed와label잔존컨테이너없음을설계가별도읽기확인했다. 현재RAG11rawSHA도고정baseline과전부일치했다. 운영4컨테이너/작업트리전후의세부확인근거는개발최종보고를기다리며수집되지않은불변을추정하지않는다.
- 성공은MD자식정상종료와parsing표시뒤종료/회수에한정해수용했다. PDF레이아웃모델메모리회수·실제변환중취소·GPU·관리자업로드·DB게시/lease복구를완료로넓히지않는다. 추가시험/재시도/하네스수정은하지않고원자료를기존v3폴더에보존한다. 제품소스/배포변경은없으며후속공유기록은로컬문서다.

## 2026-11-09 15:55 KST · 최종 확장 시험 전 에이전트 잔여 마무리 재개

- 기존 연결 채팅의 실제 사용자 메시지를 확인해 최종 목표를 에이전트 잔여 완료 후 단일 확장 시험 묶음으로 정리했다. 공유 인계의 중복된 과거 '현재 상태'를 현행 순서로 정리했고 이력은 이 일지와 기존 후보 기록에 유지했다.
- 현재 남은 우선순위는 committed 소스/운영 이미지/context 차이 확정→비RAG fix 운영 반영/부팅·복구 기준 정합성→실자료 및 W14/W15 조건 확인/관련 운영 검사→PDF/관리자 업로드/worker 복구의 필요한 자동 검증→최종 확장 묶음 준비다. 제품 구현/시험은 기존 개발 담당에게 배정했다. 이번 작업의 기능 브랜치 push/EC2 pull/관련 자동 검사는 직렬화해 계속하고, main/사용자 PR·비밀/데이터 보존 경계는 유지한다.
- RAG B안 11파일은 보존하고 최종 빌드 입력에서 제외한다. 운영 context67b8307과 committed 소스 차이는 아직 읽기 대조 중이라 유지/제외를 단정하지 않는다. 실제 CSV·사용자 인증/새 비밀번호 보관·PR 생성처럼 필수 의존성이 없으면 임의 대체하거나 완료로 기록하지 않는다. 이미 성공한 MD/CI/HTTPS 검사는 반복하지 않는다.

## 2026-11-09 16:14 KST · 자동 동기화와 최종 후보 준비·자료 대기

- 후속공유문서6커밋을c500ae5까지GitHub에push하고EC2pull--ff-only했다. 문서3경로만반영·RAG11rawSHA전후동일·빈index를설계가확인했다. 67b8307..HEAD의context.py diff가없음도설계가Git으로확인해운영일반지침이현재committed소스에있음을대조했다.
- 개발은B안11파일별도보존·committed소스만의backend/worker후보작성·기존의존성잠금일치와제품52파일해시/구문/import성공을보고했다. 패키지/모델다운로드는없고현재운영반영·W15영속초기화·부팅/복구정합성을진행중이다. 아직완료수용으로표시하지않는다. DB364문서모두게시/진행중0읽기확인도보고받았으며벡터수를새로재측정한것은아니다.
- 로컬과EC2에서지정별도연락처CSV를찾지못했다. 기존공공CSV는대체하지않고별도CSV/W03실자료매핑·W14활성화를명시대기로분리했다. W14테이블도현재없으며수집OFF유지다. 추가자료질문은반복하지않고독립작업을계속한다.
- 연결Vercel get_deployment/list_deployments로운영도메인의production은main/eb760b6(배포3LB1ip4At1wiYuHbuZeBBfXzVsZk),최신후보preview는fix-merge/c500ae5/READY(배포2Rzj5QKpt8o9c2MAR6B95gMiCGT4)임을설계가직접확인했다. 실제branchalias는welfare-helper-git-codex-fix-merge-welfare7.vercel.app이다. 관리자fix가production에이미반영됐다고주장하지않고후보alias/정상CORS·인증으로자동검증한다. mainPR/production승격우회는하지않는다.
- 개발의상세보고전송은자동심사에서직접전송승인근거부족으로거절됐다. 거절내용을우회전송하지않고실제userMessage원문을read_thread로확인해근거를검토하도록전달했으며독립준비와비민감상태보고는계속했다. 비밀/원문사용자데이터는보고에포함하지않는다.

## 2026-11-09 16:26 KST · 인증 최초 이관 보고와 운영 계약 분리

- 개발이현재비밀번호를유지한영속저장소최초생성성공을보고했다. 운영backend인증경로는아직전환하지않았으며기존사용자가아는비밀번호를새랜덤값으로바꾸지않는다. 새비밀번호회전은먼저격리정상HTTP경로로검증하고실제production회전여부/사용자보관과구분한다.
- Terra의운영반영하네스전체읽기가자동심사에서비밀/운영정보노출가능성으로차단됐다. 다른담당/도구로같은내용을읽거나반복요청해우회하지않고,비밀없는구조계약/합성fixture와기존설정의메모리내전달로분리했다. 합성검토에서잘못된컨테이너ID와중복환경변수처리공백을보완했다고보고받았다. 실제값/전체inspect/env/접속URI/인증본문을일반작업로그·스냅샷·전송에저장하지않는경계를유지한다.
- 운영반영은여전히준비중이며최신두fix의실행이미지반영/부팅복구가완료됐다고표시하지않는다. 지정CSV/W03/W14실자료전환은대기이고나머지는계속한다. 최종사용자확장시험은아래기존실행계획의한묶음요약으로준비하되에이전트자동검증완료신호전재로드를요청하지않는다.

## 2026-11-09 16:35 KST · 두 서비스 교체와 영속 인증 활성화 보고

- 운영교체/부팅핀/previeworigin추가는자동심사에서정확한범위직접승인부족으로차단돼실행되지않았다. 해당범위확정뒤반영을진행했고설계도연결된실제응답을읽어확인했다. 기존자동테스트지시만으로보안변경을우회한것이아니며비밀값출력은없었다.
- 첫반영은새backend시작전설정보존검사차이로중단돼기존backend/worker로복구됐다. OomKillDisable의미지정값→false표현만다른것을공식코드/실측으로확인하고그항목만정규화한합성검사10개성공후재개했다고보고받았다. 실패원자료는보존했으며마운트/포트/권한/env전체비교를삭제하지않았다.
- 설계가16:32시점4서비스의name/ID/image/status/health/StartedAt만직접읽었다. 새backend7fe269f305911a8e69004ef333ffa6e82c0cf600d6879b9ad83553a3250a7c63(16:32:33KST),worker5ae7df5b290797e2249ac5489cae09299a9fb95aed4ddbb6359eb2ce5ae9e820(16:32:40KST)가running/healthy였다. Ollama31b0205…/edge15d9f110…는기존ID·14:20시작을유지했다. 전체inspect/env는출력/저장하지않았다.
- 개발은현재비밀번호로그인·관리자접근/영속auth활성화·DB364게시지문및RAG11불변을보고했다. 후속원자료읽기검토전이를Docling게시/실제재발급회전/부팅복구전체성공으로넓히지않는다. 부팅핀갱신과무재시작실행경로검증을계속하고W15격리회전/PDF/worker복구의필요한잔여는이어간다. 실CSV/W03/W14는대기다.
