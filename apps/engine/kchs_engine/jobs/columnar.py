"""Сборка колоночной копии версии датасета (P5-E03, ADR-0109).

api ставит `transform:columnar.build` с планом столбцов и ключом файла; движок
читает строки ролью только для чтения и кладёт Parquet в хранилище. Результат
задания — число строк, размер и время сборки: их api пишет в метаданные копии.
"""

from typing import Any

from kchs_engine.data.columnar import ColumnarError, build
from kchs_engine.jobs.registry import PermanentJobError, handler


@handler("transform", "columnar.build")
async def columnar_build(data: dict[str, Any]) -> dict[str, Any]:
    try:
        return await build(data)
    except ColumnarError as error:
        # План копии неверен или тип поля не хранится — повтор не поможет
        raise PermanentJobError(str(error)) from error
    except KeyError as error:
        raise PermanentJobError(f"в задании нет поля {error}") from error
