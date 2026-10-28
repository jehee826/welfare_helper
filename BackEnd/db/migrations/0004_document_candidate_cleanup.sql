-- 사용자가 SQL Editor에서 검토 후 직접 실행한다. 애플리케이션은 이 파일을 자동 실행하지 않는다.
-- 기존 guard는 embedding/ready 후보를 failed/cancelled로 전환하며 비우는 것까지 막는다.
-- 현재 문서·현재 성공 작업의 불변성, 검토 설정 고정과 상태 전환은 유지하고 후보 정리만 허용한다.
-- 적용된 DB에서는 다시 실행할 필요가 없다. 기존 행이나 관리자 권한은 변경하지 않는다.
BEGIN;
CREATE OR REPLACE FUNCTION public.welfare_guard_job()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $job$
DECLARE
    allowed_states text[];
    mutable_fields text[] := ARRAY[
        'state','attempts','available_at','lease_token','lease_until','error_code','finished_at',
        'candidate_metadata','candidate_original','candidate_markdown','candidate_analysis','expected_active_job_id'
    ];
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'queued' THEN RAISE EXCEPTION '새 작업은 queued 상태로 시작해야 합니다.'; END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM public.rag_documents WHERE active_job_id = OLD.job_id) THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION '현재 검색 작업은 문서 교체 또는 문서 삭제로 정리하세요.';
        END IF;
        IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION '현재 검색 작업의 설정은 변경할 수 없습니다.'; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.document_id IS DISTINCT FROM OLD.document_id THEN
        RAISE EXCEPTION '작업 ID와 문서 소속은 변경할 수 없습니다.';
    END IF;
    IF OLD.state IN ('succeeded','failed','cancelled') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION '종료된 작업의 재시도는 새 작업으로 등록하세요.';
    END IF;
    allowed_states := CASE OLD.state
        WHEN 'queued' THEN ARRAY['queued','parsing','failed','cancelled']
        WHEN 'parsing' THEN ARRAY['parsing','awaiting_review','failed','cancelled']
        WHEN 'awaiting_review' THEN ARRAY['awaiting_review','embedding','failed','cancelled']
        WHEN 'embedding' THEN ARRAY['embedding','ready','failed','cancelled']
        WHEN 'ready' THEN ARRAY['ready','succeeded','failed','cancelled']
        ELSE ARRAY[OLD.state] END;
    IF NOT (NEW.state = ANY(allowed_states)) THEN
        RAISE EXCEPTION '허용되지 않은 작업 상태 전환: % -> %', OLD.state, NEW.state;
    END IF;
    -- 실패·취소는 검토 후보를 변경하는 대신 비워야 한다. 현재 성공 작업의 불변성은 위에서 검사한다.
    IF NEW.state IN ('failed','cancelled') AND (
        NEW.candidate_metadata <> '{}'::jsonb OR NEW.candidate_original IS NOT NULL
        OR NEW.candidate_markdown IS NOT NULL OR NEW.candidate_analysis IS NOT NULL
        OR NEW.expected_active_job_id IS NOT NULL OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL
    ) THEN
        RAISE EXCEPTION '실패·취소 작업의 후보 원문과 임시 자료를 비우세요.';
    END IF;
    IF OLD.state IN ('embedding','ready') THEN
        IF (to_jsonb(NEW)-mutable_fields) IS DISTINCT FROM (to_jsonb(OLD)-mutable_fields) THEN
            RAISE EXCEPTION '검토 완료 후 모델·설정·검토자를 바꿀 수 없습니다.';
        END IF;
        IF NEW.state NOT IN ('succeeded','failed','cancelled') AND (
            NEW.candidate_metadata IS DISTINCT FROM OLD.candidate_metadata
            OR NEW.candidate_original IS DISTINCT FROM OLD.candidate_original
            OR NEW.candidate_markdown IS DISTINCT FROM OLD.candidate_markdown
            OR NEW.candidate_analysis IS DISTINCT FROM OLD.candidate_analysis
            OR NEW.expected_active_job_id IS DISTINCT FROM OLD.expected_active_job_id
        ) THEN
            RAISE EXCEPTION '검토한 후보를 변경하지 말고 새 작업을 등록하세요.';
        END IF;
    END IF;
    RETURN NEW;
END;
$job$;
COMMIT;
