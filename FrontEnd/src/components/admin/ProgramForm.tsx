import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AdminProgram, Department, ProgramInput } from "../../api/types";

interface Props {
  initial: AdminProgram | null;
  departments: Department[];
  error: string;
  saving: boolean;
  onSave: (changes: Partial<ProgramInput>) => void;
  onCancel: () => void;
}

const blankToNull = (value: string) => (value.trim() ? value.trim() : null);

function changedFields(initial: AdminProgram | null, next: ProgramInput): Partial<ProgramInput> {
  if (!initial) return next;
  const before: ProgramInput = {
    name: initial.name,
    summary: initial.summary,
    departmentId: initial.departmentId,
    externalServiceId: initial.externalServiceId,
    sourceUrl: initial.sourceUrl,
    sourceUpdatedAt: initial.sourceUpdatedAt,
    contacts: initial.contacts,
    testOnly: initial.testOnly,
  };
  return Object.fromEntries(
    (Object.keys(next) as (keyof ProgramInput)[])
      .filter((key) => JSON.stringify(next[key]) !== JSON.stringify(before[key]))
      .map((key) => [key, next[key]]),
  );
}

export function ProgramForm({ initial, departments, error, saving, onSave, onCancel }: Props) {
  const locked = (initial?.documentCount ?? 0) > 0;
  const [name, setName] = useState(initial?.name ?? "");
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [departmentId, setDepartmentId] = useState(initial ? String(initial.departmentId) : "");
  const [externalServiceId, setExternalServiceId] = useState(initial?.externalServiceId ?? "");
  const [sourceUrl, setSourceUrl] = useState(initial?.sourceUrl ?? "");
  const [sourceUpdatedAt, setSourceUpdatedAt] = useState(initial?.sourceUpdatedAt ?? "");
  const [contactLabel, setContactLabel] = useState(initial?.contacts[0]?.label ?? "");
  const [contactPhone, setContactPhone] = useState(initial?.contacts[0]?.phone ?? "");
  const [testOnly, setTestOnly] = useState(initial?.testOnly ?? false);
  const [localError, setLocalError] = useState("");
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    (locked ? summaryRef.current : firstFieldRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, locked]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !departmentId) {
      setLocalError("제도명과 담당 부서는 꼭 입력해 주세요.");
      return;
    }
    setLocalError("");
    const otherContacts = initial?.contacts.slice(1) ?? [];
    const contacts = contactLabel.trim()
      ? [{ label: contactLabel.trim(), phone: contactPhone.trim() }, ...otherContacts]
      : otherContacts;
    onSave(
      changedFields(initial, {
        name: name.trim(),
        summary: summary.trim(),
        departmentId: Number(departmentId),
        externalServiceId: blankToNull(externalServiceId),
        sourceUrl: blankToNull(sourceUrl),
        sourceUpdatedAt: blankToNull(sourceUpdatedAt),
        contacts,
        testOnly,
      }),
    );
  }

  const shownError = localError || error;

  return (
    <div className="modal-backdrop">
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="program-form-title">
        <h2 id="program-form-title">{initial ? "복지제도 수정" : "새 복지제도 추가"}</h2>
        <p className="notice small">
          신청 자격·지원 내용·신청 방법은 여기서 입력하지 않아요. 원문 문서를 올리면 자동 분석 후 챗봇 답변의 근거로 반영돼요.
        </p>
        {locked && (
          <p className="muted small">
            연결된 원문 문서가 {initial?.documentCount}건 있어 제도명·서비스 ID·테스트용 여부는 바꿀 수 없어요.
          </p>
        )}
        <form onSubmit={handleSubmit} className="program-form">
          <label className="field">
            <span className="field__label">제도명 *</span>
            <input ref={firstFieldRef} value={name} disabled={locked} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">요약</span>
            <textarea ref={summaryRef} rows={2} value={summary} maxLength={2000} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <div className="grid-2">
            <label className="field">
              <span className="field__label">담당 부서 *</span>
              <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">부서를 골라 주세요</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.ministry} · {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">외부 서비스 ID</span>
              <input
                value={externalServiceId}
                disabled={locked}
                placeholder="예: WLF00001164 (없으면 비워 두세요)"
                onChange={(e) => setExternalServiceId(e.target.value.toUpperCase())}
              />
            </label>
            <label className="field">
              <span className="field__label">출처 URL</span>
              <input type="url" value={sourceUrl} placeholder="https://" onChange={(e) => setSourceUrl(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">원자료 갱신일</span>
              <input type="date" value={sourceUpdatedAt} onChange={(e) => setSourceUpdatedAt(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">문의처 이름</span>
              <input value={contactLabel} onChange={(e) => setContactLabel(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">문의처 전화번호</span>
              <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} inputMode="tel" />
            </label>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={testOnly} disabled={locked} onChange={(e) => setTestOnly(e.target.checked)} />
            테스트용 제도 (이용자 검색에서 빠져요)
          </label>
          {shownError && (
            <p role="alert" className="field__error">
              {shownError}
            </p>
          )}
          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onCancel}>
              취소
            </button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              저장
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
