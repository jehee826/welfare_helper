import math


def validate_embeddings(vectors: object, count: int, dimension: int | None = None) -> None:
    """임베딩 개수·차원·유한값을 확인하고 코사인 검색이 불가능한 영벡터를 거부한다."""
    if not isinstance(vectors, list) or len(vectors) != count:
        raise ValueError("임베딩 개수가 입력 개수와 다릅니다.")
    for vector in vectors:
        if not isinstance(vector, list) or not vector:
            raise ValueError("비어 있거나 잘못된 임베딩입니다.")
        if dimension is None:
            dimension = len(vector)
        if len(vector) != dimension:
            raise ValueError(f"임베딩 차원은 {dimension}이어야 합니다.")
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in vector):
            raise ValueError("임베딩에는 유한한 숫자만 사용할 수 있습니다.")
        if not any(vector):
            raise ValueError("영벡터는 코사인 검색에 사용할 수 없습니다.")
