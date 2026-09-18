"""CLI генератора демо-данных:
`python -m kchs_engine.demo --out <каталог|s3://бакет/префикс> --profile demo|small`.
"""

import argparse
import resource
import sys
import time

from kchs_engine.demo import DATASET_IDS, DEFAULT_SEED, PROFILES, Written, generate
from kchs_engine.demo.output import parse_target


def peak_memory_mb() -> float:
    """Пиковая память процесса (RSS), МБ: macOS считает в байтах, Linux — в килобайтах."""
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / (1024 * 1024) if sys.platform == "darwin" else peak / 1024


def _number(value: float, digits: int = 0) -> str:
    return f"{value:,.{digits}f}".replace(",", " ").replace(".", ",")


def _report(written: Written) -> None:
    megabytes = written.bytes / 1024 / 1024
    speed = written.rows / written.seconds if written.seconds > 0 else 0.0
    print(
        f"{written.spec.file}: {_number(written.rows)} строк, {_number(megabytes, 1)} МБ, "
        f"{_number(written.seconds, 1)} с ({_number(speed)} строк/с) → {written.location}",
        file=sys.stderr,
        flush=True,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m kchs_engine.demo",
        description="Демо-данные фазы 1: справочники и датасеты файлами для конвейера "
        "импорта (ADR-0046) и manifest.json с параметрами загрузки.",
    )
    parser.add_argument("--out", required=True, help="каталог или s3://бакет/префикс")
    parser.add_argument(
        "--profile",
        choices=sorted(PROFILES),
        default="demo",
        help="small — 50 тыс. происшествий, demo — 5 млн (по умолчанию)",
    )
    parser.add_argument(
        "--seed", type=int, default=DEFAULT_SEED, help=f"seed (по умолчанию {DEFAULT_SEED})"
    )
    parser.add_argument("--only", help=f"только эти наборы через запятую: {', '.join(DATASET_IDS)}")
    parser.add_argument(
        "--incidents", type=int, help="строк «Происшествий» вместо профиля (для замеров)"
    )
    args = parser.parse_args(argv)
    only = {item.strip() for item in args.only.split(",") if item.strip()} if args.only else None
    started = time.perf_counter()
    try:
        generate(
            parse_target(args.out),
            PROFILES[args.profile],
            seed=args.seed,
            only=only,
            incidents=args.incidents,
            report=_report,
        )
    except ValueError as error:
        parser.error(str(error))
    print(
        f"Готово за {_number(time.perf_counter() - started, 1)} с; "
        f"пик памяти процесса {_number(peak_memory_mb())} МБ",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
