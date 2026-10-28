import { DocumentApiError, documentRequest, jsonPost } from "./documentApi";
import type { ChatAnswer, UserProfile } from "./types";

export interface DocumentEvidence {
  chunk_id: string; quote: string; context: string; document_id: string;
  pages: number[]; source_blocks: string[]; source_url: string;
  role?: "claim" | "required_context" | "retrieved"; required_by?: string[];
}
export type DocumentChatAnswer = ChatAnswer & { evidence?: DocumentEvidence[] };

export function createDocumentChatApi(documentId: string) {
  return {
    initialSuggestions: () => [] as string[],
    async ask(query: string, _profile: UserProfile | null, signal: AbortSignal = new AbortController().signal): Promise<DocumentChatAnswer> {
      const result = await documentRequest<{
        scope_document_id: string;
        response: { kind: string; text: string; evidence?: DocumentEvidence[] };
      }>(`/${documentId}/query`, signal, jsonPost({ query }));
      if (result.scope_document_id.toLowerCase() !== documentId.toLowerCase()
        || result.response.evidence?.some(item => item.document_id.toLowerCase() !== documentId.toLowerCase())) {
        throw new DocumentApiError(409, "document_scope_changed");
      }
      // 문서 대화에는 복지 추천·상담원 연결을 섞지 않는다. 서버의 문서 접근 권한 검사는 그대로 적용한다.
      return result.response.kind === "answer"
        ? { kind: "answer", text: result.response.text, services: [], suggestions: [], evidence: result.response.evidence ?? [] }
        : { kind: "fallback", text: result.response.text, contacts: [], suggestions: [], evidence: result.response.evidence ?? [] };
    },
  };
}
