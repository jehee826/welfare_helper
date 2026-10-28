"""CSV 메타데이터의 오프라인 확인만 제공한다. 문서 벡터 저장소에는 적재하지 않는다."""

import argparse
import sys

from BackEnd.ingest.csv_loader import DEFAULT_CSV, CsvFormatError, load_csv


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="CSV 확인 전용입니다. 새 DB는 검토한 문서 작업으로 색인합니다.")
    parser.add_argument("--csv", default=str(DEFAULT_CSV))
    parser.add_argument("--encoding", default="cp949")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--prune", action="store_true")
    parser.add_argument("--allow-shared-write", action="store_true")
    parser.add_argument("--check-embeddings", action="store_true")
    parser.add_argument("--batch-size", type=int, default=32)
    args = parser.parse_args(argv)
    if not args.dry_run or args.prune or args.allow_shared_write or args.check_embeddings:
        print("CSV DB 적재·prune·overview 임베딩은 지원하지 않습니다. --dry-run으로 메타데이터만 확인하고 "
              "문서는 관리자 문서 API에서 분석·검토·색인하세요.", file=sys.stderr)
        return 1
    try:
        records = load_csv(args.csv, encoding=args.encoding)
    except (CsvFormatError, OSError, UnicodeError) as exc:
        print(f"CSV 확인 실패: {exc}", file=sys.stderr)
        return 1
    print(f"CSV 메타데이터 {len(records)}건. DB·모델 호출과 적재는 하지 않았습니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
