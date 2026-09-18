"""Детерминированные случайные числа генератора демо-данных.

Python гарантирует между версиями только последовательность `random()` для
одного и того же seed (строковый seed сводится к целому через SHA-512), а
алгоритмы `gauss`, `choices`, `randrange` и прочих методов могут меняться.
Поэтому всё остальное — нормальное и логнормальное распределения, выбор по
весам, геометрическое распределение — построено здесь поверх одного `random()`.

У каждого набора данных свой поток (`stream`): изменение объёма одного файла
не сдвигает случайные числа других.
"""

import math
import random
from bisect import bisect_right
from collections.abc import Iterable

TWO_PI = 2.0 * math.pi


class Rng:
    """Поток случайных чисел для одного набора данных."""

    __slots__ = ("_spare", "random")

    def __init__(self, seed: int, stream: str) -> None:
        self.random = random.Random(f"kchs-demo:{seed}:{stream}").random
        self._spare: float | None = None

    def uniform(self, low: float, high: float) -> float:
        return low + (high - low) * self.random()

    def below(self, count: int) -> int:
        """Целое 0…count−1."""
        return min(int(self.random() * count), count - 1)

    def between(self, low: int, high: int) -> int:
        """Целое low…high включительно."""
        return low + self.below(high - low + 1)

    def chance(self, probability: float) -> bool:
        return self.random() < probability

    def normal(self) -> float:
        """Стандартное нормальное (Бокс — Мюллер, второе значение пары — в запасе)."""
        spare = self._spare
        if spare is not None:
            self._spare = None
            return spare
        radius = math.sqrt(-2.0 * math.log(1.0 - self.random()))
        angle = TWO_PI * self.random()
        self._spare = radius * math.sin(angle)
        return radius * math.cos(angle)

    def lognormal(self, median: float, sigma: float) -> float:
        return median * math.exp(sigma * self.normal())

    def log_uniform(self, low: float, high: float) -> float:
        """Равномерно по порядку величины: вместимости, площади, расстояния."""
        return low * math.exp(self.random() * math.log(high / low))

    def geometric(self, mean: float) -> int:
        """Целое ≥ 1 со средним `mean` (число пострадавших, если они есть)."""
        if mean <= 1.0:
            return 1
        ratio = 1.0 - 1.0 / mean
        return 1 + int(math.log(1.0 - self.random()) / math.log(ratio))

    def pick(self, weights: "Weights") -> int:
        return weights.index(self.random())

    def item[T](self, items: tuple[T, ...] | list[T]) -> T:
        return items[self.below(len(items))]

    def disk(self, radius_km: float, power: float = 0.5) -> tuple[float, float]:
        """Смещение (восток, север) в км внутри круга; power 0.5 — равномерно по площади,
        больше — гуще к центру."""
        distance = radius_km * self.random() ** power
        angle = TWO_PI * self.random()
        return distance * math.cos(angle), distance * math.sin(angle)


class Weights:
    """Накопленные веса для выбора индекса одним случайным числом."""

    __slots__ = ("_cumulative", "_last", "total")

    def __init__(self, weights: Iterable[float]) -> None:
        cumulative: list[float] = []
        running = 0.0
        last = -1
        for index, weight in enumerate(weights):
            if weight < 0:
                raise ValueError("вес не может быть отрицательным")
            if weight > 0:
                last = index
            running += weight
            cumulative.append(running)
        if last < 0:
            raise ValueError("нужен хотя бы один положительный вес")
        self._cumulative = cumulative
        # Последний индекс с ненулевым весом: доля, округлённая до 1, выбирает его
        self._last = last
        self.total = running

    def index(self, fraction: float) -> int:
        """Индекс для доли 0…1 (нулевые веса не выбираются)."""
        position = bisect_right(self._cumulative, fraction * self.total)
        return position if position < self._last else self._last

    def __len__(self) -> int:
        return len(self._cumulative)
