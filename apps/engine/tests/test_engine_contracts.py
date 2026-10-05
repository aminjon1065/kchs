"""Модели движка совпадают с контрактом заданий и обратных вызовов (ADR-0190).

Источник — zod-схемы `packages/contracts/src/engine`; `gen:engine` пишет их JSON
Schema в `kchs_engine/contracts/jobs.json`. Модели движка (`contracts/jobs.py`,
`contracts/callbacks.py`) написаны руками, поэтому здесь сверяются со схемами:

- у объекта те же поля, что в схеме, — новое поле api не пройдёт незамеченным;
- то, что движок получает (нагрузка, ответ api), модель принимает целиком: любое
  значение схемы api проходит модель, обязательны в модели только поля, которые
  api присылает всегда;
- то, что движок отправляет (результат, тело вызова), api примет: значения модели —
  подмножество схемы, обязательное в схеме обязательно и в модели.

Пределы длины и диапазоны проверяет api своей схемой; здесь сверяется форма.
"""

import inspect
from types import SimpleNamespace
from typing import Any

import pytest
from bullmq.custom_errors import UnrecoverableError
from pydantic import TypeAdapter

from kchs_engine import api, worker
from kchs_engine.contracts import jobs_contract
from kchs_engine.contracts.callbacks import CALLBACK_CONTRACTS
from kchs_engine.contracts.jobs import ENVELOPE, JOB_CONTRACTS
from kchs_engine.demo import PROFILES
from kchs_engine.jobs import JOB_HANDLERS, PermanentJobError, handler
from kchs_engine.jobs.echo import echo
from kchs_engine.jobs.registry import _checked

Schema = dict[str, Any]
JOBS: dict[str, Schema] = jobs_contract()["jobs"]
CALLBACKS: dict[str, Schema] = jobs_contract()["callbacks"]

# ─── Совместимость двух JSON Schema ─────────────────────────────────────────


def _resolve(node: Any, root: Schema) -> Any:
    while isinstance(node, dict) and "$ref" in node:
        node = root["$defs"][node["$ref"].removeprefix("#/$defs/")]
    return node


def _variants(node: Any, root: Schema) -> list[Schema]:
    """Варианты значения: ветви anyOf/oneOf, `type: [a, b]` — по типу."""
    node = _resolve(node, root)
    if node is True or node == {}:
        return [{}]
    for key in ("anyOf", "oneOf"):
        if key in node:
            return [variant for item in node[key] for variant in _variants(item, root)]
    kind = node.get("type")
    if isinstance(kind, list):
        rest = {key: value for key, value in node.items() if key != "type"}
        return [{**rest, "type": item} for item in kind]
    return [node]


def _json_kind(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    return "string" if isinstance(value, str) else "object"


def _kind(node: Schema) -> str:
    if "type" in node:
        return str(node["type"])
    if "const" in node:
        return _json_kind(node["const"])
    if "enum" in node:
        kinds = {_json_kind(value) for value in node["enum"]}
        return kinds.pop() if len(kinds) == 1 else "any"
    if "properties" in node or "additionalProperties" in node:
        return "object"
    return "array" if "items" in node else "any"


def _values(node: Any) -> set[Any] | None:
    """Допустимые значения перечня или константы; `None` — любые."""
    if not isinstance(node, dict):
        return None
    if "const" in node:
        return {node["const"]}
    return set(node["enum"]) if "enum" in node else None


def _free(node: Any) -> bool:
    return node is True or node == {} or node is None


def _object(r: Schema, rroot: Schema, s: Schema, sroot: Schema, path: str) -> list[str]:
    rprops, sprops = r.get("properties"), s.get("properties")
    problems: list[str] = []
    if rprops is not None and sprops is not None:
        if set(rprops) != set(sprops):
            problems.append(
                f"{path}: поля расходятся — только в схеме отправителя "
                f"{sorted(set(sprops) - set(rprops))}, только у приёмника "
                f"{sorted(set(rprops) - set(sprops))}"
            )
        missing = set(r.get("required", [])) - set(s.get("required", []))
        if missing:
            problems.append(f"{path}: приёмник требует {sorted(missing)}, их могут не прислать")
        for name in sorted(set(rprops) & set(sprops)):
            problems += accepts(
                rprops[name], s_node=sprops[name], rroot=rroot, sroot=sroot, path=f"{path}.{name}"
            )
        return problems
    if rprops is not None:
        return [f"{path}: приёмник ждёт поля {sorted(rprops)}, а приходит словарь"]

    # Приёмник — словарь (или любой объект)
    rvalue = _resolve(r.get("additionalProperties"), rroot)
    rnames = _values(_resolve(r.get("propertyNames"), rroot))
    if sprops is not None:
        if rnames is not None and not set(sprops) <= rnames:
            problems.append(f"{path}: ключи {sorted(set(sprops) - rnames)} вне {sorted(rnames)}")
        if not _free(rvalue):
            for name in sorted(sprops):
                problems += accepts(
                    rvalue, s_node=sprops[name], rroot=rroot, sroot=sroot, path=f"{path}.{name}"
                )
        return problems
    snames = _values(_resolve(s.get("propertyNames"), sroot))
    if rnames is not None and (snames is None or not snames <= rnames):
        problems.append(f"{path}: ключи словаря отправителя не ограничены перечнем приёмника")
    if _free(rvalue):
        return problems
    svalue = _resolve(s.get("additionalProperties"), sroot)
    if _free(svalue):
        return [*problems, f"{path}: значения словаря отправителя любые"]
    return problems + accepts(rvalue, s_node=svalue, rroot=rroot, sroot=sroot, path=f"{path}{{}}")


def _variant(r: Schema, rroot: Schema, s: Schema, sroot: Schema, path: str) -> list[str]:
    rkind, skind = _kind(r), _kind(s)
    if rkind == "any":
        return []
    if skind == "any":
        return [f"{path}: отправитель шлёт что угодно, приёмник ждёт {rkind}"]
    if rkind != skind and not (rkind == "number" and skind == "integer"):
        return [f"{path}: {skind} вместо {rkind}"]
    if rkind == "array":
        return accepts(
            r.get("items", {}),
            s_node=s.get("items", {}),
            rroot=rroot,
            sroot=sroot,
            path=f"{path}[]",
        )
    if rkind == "object":
        return _object(r, rroot, s, sroot, path)
    rvalues, svalues = _values(r), _values(s)
    if rvalues is not None and (svalues is None or not svalues <= rvalues):
        sent = "любые" if svalues is None else sorted(map(str, svalues - rvalues))
        return [f"{path}: значения {sent} вне {sorted(map(str, rvalues))}"]
    return []


def accepts(
    r_node: Any, *, s_node: Any, rroot: Schema, sroot: Schema, path: str = "$"
) -> list[str]:
    """Что приёмник (`r_node`) не примет из того, что может прислать отправитель."""
    receivers = _variants(r_node, rroot)
    problems: list[str] = []
    for sent in _variants(s_node, sroot):
        attempts = [_variant(item, rroot, sent, sroot, path) for item in receivers]
        if all(attempts):
            problems += min(attempts, key=len)
    return problems


def compatible(receiver: Schema, sender: Schema) -> list[str]:
    return accepts(receiver, s_node=sender, rroot=receiver, sroot=sender)


def model(adapter: TypeAdapter[Any]) -> Schema:
    return adapter.json_schema(mode="validation")


# ─── Модели и схемы контракта ───────────────────────────────────────────────


def test_contract_and_engine_know_the_same_jobs() -> None:
    assert set(JOB_CONTRACTS) == set(JOBS)
    assert set(CALLBACK_CONTRACTS) == set(CALLBACKS)
    # Обработчики регистрируются импортом модулей воркера; без контракта — не регистрируются
    assert set(JOB_HANDLERS) == set(JOBS)
    for key, spec in JOBS.items():
        assert key == f"{spec['queue']}:{spec['name']}"


def test_envelope_accepts_what_api_adds() -> None:
    assert compatible(model(ENVELOPE), jobs_contract()["envelope"]) == []


@pytest.mark.parametrize("key", sorted(JOBS))
def test_job_payload_model_accepts_api_payload(key: str) -> None:
    assert compatible(model(JOB_CONTRACTS[key].payload), JOBS[key]["payload"]) == []


@pytest.mark.parametrize("key", sorted(JOBS))
def test_job_result_model_fits_api_schema(key: str) -> None:
    assert compatible(JOBS[key]["result"], model(JOB_CONTRACTS[key].result)) == []


@pytest.mark.parametrize("name", sorted(CALLBACKS))
def test_callback_body_model_fits_api_schema(name: str) -> None:
    body, adapter = CALLBACKS[name]["body"], CALLBACK_CONTRACTS[name].body
    if body is None:
        assert adapter is None
        return
    assert adapter is not None
    assert compatible(body, model(adapter)) == []


@pytest.mark.parametrize("name", sorted(CALLBACKS))
def test_callback_reply_model_accepts_api_reply(name: str) -> None:
    assert compatible(model(CALLBACK_CONTRACTS[name].reply), CALLBACKS[name]["reply"]) == []


def test_compatibility_check_finds_drift() -> None:
    """Сама проверка: расхождения, которые она обязана находить."""

    def obj(props: Schema, required: list[str]) -> Schema:
        return {"type": "object", "properties": props, "required": required}

    integer, string = {"type": "integer"}, {"type": "string"}
    # Тип поля, лишнее поле, необязательное у отправителя — обязательное у приёмника
    assert compatible(obj({"a": integer}, ["a"]), obj({"a": string}, ["a"]))
    assert compatible(obj({"a": integer}, ["a"]), obj({"a": integer, "b": integer}, ["a"]))
    assert compatible(obj({"a": integer}, ["a"]), obj({"a": integer}, []))
    # null, которого приёмник не ждёт; значение вне перечня
    nullable = {"anyOf": [integer, {"type": "null"}]}
    assert compatible(obj({"a": integer}, ["a"]), obj({"a": nullable}, ["a"]))
    assert compatible({"type": "string", "enum": ["x"]}, {"type": "string", "enum": ["x", "y"]})
    # Совместимые: целое в число, перечень в строку, вариант объединения
    assert compatible({"type": "number"}, integer) == []
    assert compatible(string, {"type": "string", "enum": ["x", "y"]}) == []
    assert compatible({"oneOf": [integer, string]}, string) == []


def test_api_paths_and_names_from_contract() -> None:
    assert api.callback_path("importNormalized", "imp-1") == (
        "/api/v1/internal/data/imports/imp-1/normalized"
    )
    assert api.callback_path("usersImportParsed", "job-1") == (
        "/api/v1/internal/users-import/job-1/parsed"
    )
    assert api.callback_path("reportRenderStart", "run/1") == (
        "/api/v1/internal/reports/runs/run%2F1/start"
    )
    source = inspect.getsource(api)
    for name in CALLBACKS:
        assert f'"{name}"' in source, name


def test_demo_profiles_match_contract() -> None:
    assert set(PROFILES) == set(jobs_contract()["demoProfiles"])


# ─── Проверка на входе и выходе ─────────────────────────────────────────────


async def test_handler_rejects_payload_off_contract() -> None:
    with pytest.raises(PermanentJobError, match=r"engine\.echo не по контракту: message"):
        await echo({"text": "проверка"})
    # Конверт и лишние поля нагрузке не мешают
    result = await echo({"message": "проверка", "jobRecordId": "rec-1", "extra": 1})
    assert result["echo"] == "проверка"


async def test_handler_rejects_result_off_contract() -> None:
    async def broken(_data: dict[str, Any]) -> dict[str, Any]:
        return {"echo": 1}

    run = _checked("transform:engine.echo", JOB_CONTRACTS["transform:engine.echo"], broken)
    with pytest.raises(PermanentJobError, match=r"Результат задания transform:engine\.echo"):
        await run({"message": "проверка"})


def test_handler_without_contract_is_not_registered() -> None:
    with pytest.raises(ValueError, match="нет в контракте"):

        @handler("transform", "engine.unknown")
        async def unknown(data: dict[str, Any]) -> dict[str, Any]:
            return data

    assert "transform:engine.unknown" not in JOB_HANDLERS


async def test_worker_refuses_job_without_envelope() -> None:
    process = worker._make_processor("transform")
    job = SimpleNamespace(name="engine.echo", id="bull-1", data={"message": "x"}, attemptsMade=0)
    with pytest.raises(UnrecoverableError, match="без конверта api: jobRecordId"):
        await process(job, "lock")  # type: ignore[arg-type]


async def test_callback_body_and_reply_are_checked(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[tuple[str, dict[str, Any]]] = []
    reply: dict[str, Any] = {"loadJobId": None}

    async def fake_post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
        sent.append((path, payload))
        return reply

    monkeypatch.setattr(api, "_post_strict", fake_post)
    with pytest.raises(api.CallbackContractError, match="importNormalized"):
        await api.report_dataset_normalized("imp-1", {"rows": 1})
    assert sent == []

    report = {
        "jobRecordId": "job-1",
        "rows": 3,
        "errors": 0,
        "normalizedKey": "imports/imp-1/normalized.csv",
        "errorsKey": None,
        "errorSample": [],
    }
    assert await api.report_dataset_normalized("imp-1", report) == {"loadJobId": None}
    assert sent == [("/api/v1/internal/data/imports/imp-1/normalized", report)]

    reply = {"status": "render"}
    with pytest.raises(api.CallbackContractError, match="ответ api на documentRenderStart"):
        await api.document_render_start("render-1")
