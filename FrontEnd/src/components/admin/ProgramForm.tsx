import { useEffect, useRef, useState, type FormEvent } from "react";
import type { WelfareProgram } from "../../api/types";

export const CATEGORIES = ["생활", "주거", "일자리", "돌봄", "의료"];

interface Props {
  initial: WelfareProgram | null;
  onSave: (program: WelfareProgram) => void;
  onCancel: () => void;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ProgramForm({ initial, onSave, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [ministry, setMinistry] = useState(initial?.ministry ?? "");
  const [department, setDepartment] = useState(initial?.department ?? "");
  const [category, setCategory] = useState(initial?.category ?? CATEGORIES[0]);
  const [keywords, setKeywords] = useState(initial?.keywords.join(", ") ?? "");
  const [eligibility, setEligibility] = useState(initial?.eligibility ?? "");
  const [benefit, setBenefit] = useState(initial?.benefit ?? "");
  const [howToApply, setHowToApply] = useState(initial?.howToApply ?? "");
  const [contactLabel, setContactLabel] = useState(initial?.contacts[0]?.label ?? "");
  const [contactPhone, setContactPhone] = useState(initial?.contacts[0]?.phone ?? "");
  const [error, setError] = useState("");
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !summary.trim()) {
      setError("제도명과 요약은 꼭 입력해 주세요.");
      return;
    }
    const otherContacts = initial?.contacts.slice(1) ?? [];
    const contacts = contactLabel.trim()
      ? [{ label: contactLabel.trim(), phone: contactPhone.trim() }, ...otherContacts]
      : otherContacts;
    onSave({
      id: initial?.id ?? `LOCAL-${Date.now()}`,
      name: name.trim(),
      summary: summary.trim(),
      ministry: ministry.trim(),
      department: department.trim(),
      contacts,
      url: initial?.url ?? "",
      updatedAt: today(),
      category,
      keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
      eligibility: eligibility.trim(),
      benefit: benefit.trim(),
      howToApply: howToApply.trim(),
    });
  }

  return (
    <div className="modal-backdrop">
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="program-form-title">
        <h2 id="program-form-title">{initial ? "복지제도 수정" : "새 복지제도 추가"}</h2>
        <form onSubmit={handleSubmit} className="program-form">
          <label className="field">
            <span className="field__label">제도명 *</span>
            <input ref={firstFieldRef} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">요약 *</span>
            <textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <div className="grid-2">
            <label className="field">
              <span className="field__label">소관 부처·기관</span>
              <input value={ministry} onChange={(e) => setMinistry(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">담당 부서</span>
              <input value={department} onChange={(e) => setDepartment(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">분야</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">검색 키워드 (쉼표로 구분)</span>
              <input value={keywords} onChange={(e) => setKeywords(e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span className="field__label">신청 자격</span>
            <textarea rows={2} value={eligibility} onChange={(e) => setEligibility(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">지원 내용</span>
            <textarea rows={2} value={benefit} onChange={(e) => setBenefit(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">신청 방법</span>
            <textarea rows={2} value={howToApply} onChange={(e) => setHowToApply(e.target.value)} />
          </label>
          <div className="grid-2">
            <label className="field">
              <span className="field__label">문의처 이름</span>
              <input value={contactLabel} onChange={(e) => setContactLabel(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">문의처 전화번호</span>
              <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} inputMode="tel" />
            </label>
          </div>
          {error && (
            <p role="alert" className="field__error">
              {error}
            </p>
          )}
          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onCancel}>
              취소
            </button>
            <button type="submit" className="btn btn--primary">
              저장
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
