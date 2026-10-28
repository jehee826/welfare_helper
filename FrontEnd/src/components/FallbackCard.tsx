import { useState } from "react";
import type { Contact } from "../api/types";
import { FALLBACK_SCOPE_NOTICE } from "../lib/notice";
import { ContactList } from "./ContactList";

export function FallbackCard({ text, contacts }: { text: string; contacts: Contact[] }) {
  const [requested, setRequested] = useState(false);

  return (
    <div className="bubble bubble--bot bubble--fallback">
      <p className="badge">확인이 필요해요</p>
      <p className="bubble__text">{text}</p>
      <p className="muted small scope-notice">{FALLBACK_SCOPE_NOTICE}</p>
      <ContactList contacts={contacts} />
      {requested ? (
        <p className="notice" role="status">
          상담원 연결 요청을 받았어요. 목업에서는 요청이 실제로 전송되지 않으니 위 번호로 전화해 주세요.
        </p>
      ) : (
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setRequested(true)}>
          상담원 연결 요청
        </button>
      )}
    </div>
  );
}
