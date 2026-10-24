"""Docling 결과만 정규화한다. 원본 텍스트를 임베딩하는 대체 경로는 없다."""

import hashlib
import importlib.metadata
import logging
import json
from pathlib import Path
import re
import unicodedata

from BackEnd.documents.contracts import DocumentError, PARSER_VERSION
from BackEnd.documents.contracts import stable_hash
from BackEnd.ingest.official import plain_text


def model_cache(root: Path) -> dict:
    from huggingface_hub import snapshot_download

    root.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for repo, revision in [("docling-project/docling-layout-heron", "8f39ad3"),
                           ("docling-project/docling-models", "fc0f2d4")]:
        folder = root / repo.replace("/", "--")
        # 원격 코드 실행 없이 저장소의 고정 커밋 파일만 준비한다.
        patterns = ["*.json", "*.safetensors"] if "layout-heron" in repo else ["model_artifacts/tableformer/accurate/*"]
        snapshot_download(repo, revision=revision, local_dir=folder, allow_patterns=patterns)
        files = [p for p in folder.rglob("*") if p.is_file() and ".cache" not in p.parts]
        if not files:
            raise DocumentError("docling_models_missing")
        for path in files:
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            manifest[str(path.relative_to(root))] = digest.hexdigest()
    return manifest


def normalize(value: str) -> str:
    return "\n".join(re.sub(r"[^\S\n]+", " ", line).strip()
                     for line in unicodedata.normalize("NFC", value).splitlines() if line.strip())


def read_analysis(store, document_id, max_bytes):
    job = store.analysis_result(document_id)
    result = job["result"]
    try:
        analysis = store.analysis_data(document_id)
        if len(json.dumps(analysis, ensure_ascii=False).encode()) > max_bytes:
            raise DocumentError("analysis_artifact_size_limit")
    except (ValueError, KeyError):
        raise DocumentError("analysis_artifact_invalid") from None
    if stable_hash(analysis) != result["analysis_hash"]:
        raise DocumentError("analysis_artifact_hash_mismatch")
    return job, analysis


def analyze_file(path: Path, config: dict, settings, progress=lambda stage: None) -> dict:
    # 업로드 원문이 포함될 수 있는 라이브러리 로그와 예외 본문은 내보내지 않는다.
    logging.disable(logging.CRITICAL)
    if importlib.metadata.version("docling-slim") != "2.141.0":
        raise DocumentError("docling_version_mismatch")
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat, ConversionStatus
    from docling.datamodel.pipeline_options import PdfPipelineOptions, TesseractCliOcrOptions
    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions

    manifests, options = {}, {}
    if path.suffix == ".pdf":
        progress("downloading_models")
        cache = Path(settings.docling_cache_dir) / PARSER_VERSION
        manifests = model_cache(cache)
        pdf = PdfPipelineOptions(artifacts_path=cache, enable_remote_services=False, do_ocr=config["ocr"],
                                 do_table_structure=True, do_code_enrichment=False, do_formula_enrichment=False,
                                 generate_page_images=False, generate_picture_images=False,
                                 document_timeout=settings.documents_parse_timeout,
                                 accelerator_options=AcceleratorOptions(num_threads=2, device=AcceleratorDevice.CPU),
                                 ocr_options=TesseractCliOcrOptions(lang=["kor", "eng"]))
        pdf.layout_options.model_spec = pdf.layout_options.model_spec.model_copy(update={"revision": "8f39ad3"})
        options[InputFormat.PDF] = PdfFormatOption(pipeline_options=pdf)
    progress("parsing")
    converter = DocumentConverter(allowed_formats=[InputFormat.PDF, InputFormat.DOCX, InputFormat.MD], format_options=options)
    result = converter.convert(path, raises_on_error=False, max_num_pages=config["max_pages"],
                               max_file_size=settings.documents_max_file_mb * 1024 * 1024)
    if result.status != ConversionStatus.SUCCESS:
        raise DocumentError("docling_conversion_incomplete")
    document = result.document
    blocks, blockers, warnings = [], [], []
    if result.errors:
        blockers.append("docling_reported_errors")
    for item, level in document.iterate_items():
        label = str(getattr(item.label, "value", item.label))
        reference = str(item.self_ref)
        pages = sorted({int(prov.page_no) for prov in item.prov})
        text = normalize(getattr(item, "text", ""))
        table = None
        if label == "table":
            table = item.data.model_dump(mode="json")
            rows, cols = table.get("num_rows", 0), table.get("num_cols", 0)
            cells, coverage = table.get("table_cells", []), set()
            if rows <= 0 or cols <= 0 or rows * cols > 20000 or not cells:
                blockers.append("invalid_table_dimensions")
            else:
                for cell in cells:
                    start_r, end_r = cell["start_row_offset_idx"], cell["end_row_offset_idx"]
                    start_c, end_c = cell["start_col_offset_idx"], cell["end_col_offset_idx"]
                    if not 0 <= start_r < end_r <= rows or not 0 <= start_c < end_c <= cols:
                        blockers.append("invalid_table_cell_range")
                        continue
                    positions = {(r, c) for r in range(start_r, end_r) for c in range(start_c, end_c)}
                    if positions & coverage:
                        blockers.append("overlapping_table_cells")
                    coverage.update(positions)
                if len(coverage) != rows * cols:
                    blockers.append("table_grid_incomplete")
            if not blockers:
                text = plain_text(item.export_to_html(doc=document))
            if not text:
                blockers.append("empty_table_extraction")
        elif label == "picture":
            warnings.append("picture_requires_source_review")
        if not text and label != "picture":
            continue
        if path.suffix == ".pdf" and not pages:
            blockers.append("pdf_provenance_missing")
        blocks.append({"id": reference, "label": label, "level": getattr(item, "level", level), "pages": pages,
                       "text": text, "table": table})
    if len({b["id"] for b in blocks}) != len(blocks):
        blockers.append("duplicate_source_blocks")
    characters = sum(len(b["text"]) for b in blocks)
    if not characters:
        blockers.append("empty_extraction")
    if characters > config["max_characters"] or len(blocks) > 10000:
        raise DocumentError("analysis_size_limit")
    pages = sorted(int(page) for page in document.pages)
    if path.suffix == ".pdf":
        represented = {page for b in blocks if b["text"] for page in b["pages"]}
        if not pages or not set(pages).issubset(represented):
            blockers.append("empty_or_unparsed_pdf_pages")
    else:
        warnings.append("unpaginated_source_use_block_anchors")
    return {"parser_version": PARSER_VERSION, "docling_version": "2.141.0", "source_format": path.suffix[1:],
            "runtime_versions": {name: importlib.metadata.version(name) for name in ("docling-slim", "docling-core")},
            "model_files": manifests, "pages": pages, "blocks": blocks, "characters": characters,
            "blockers": sorted(set(blockers)), "warnings": sorted(set(warnings)),
            "markdown": document.export_to_markdown(), "docling_document": document.export_to_dict()}
