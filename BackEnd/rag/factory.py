from BackEnd.rag.chat import ChatService
from BackEnd.rag.ollama import OllamaClient
from BackEnd.rag.reranker import LocalReranker


def build_chat_service(repo, settings):
    llm = OllamaClient(settings.ollama_base_url, settings.ollama_embed, settings.ollama_llm,
        settings.ollama_timeout, {"temperature": settings.llm_temperature, "num_ctx": settings.llm_num_ctx,
                                "num_predict": settings.llm_num_predict, "num_thread": settings.llm_num_thread},
        embed_dim=settings.embed_dim)
    reranker = LocalReranker(settings.rerank_model, settings.rerank_revision, settings.rerank_cache_dir,
                             settings.rerank_max_length, settings.rerank_threads)
    return ChatService(repo, llm, settings.min_dense_sim, settings.retrieve_top_n,
                       reranker=reranker, min_rerank_score=settings.min_rerank_score,
                       dense_k=settings.dense_top_k, keyword_k=settings.keyword_top_k, core_k=settings.core_evidence_k)
