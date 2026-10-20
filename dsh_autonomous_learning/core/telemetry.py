"""结构化运行日志（JSONL）。

审计 P7 要求"日志可观测"：每个任务、每次预算变更、每次检索都该能事后复盘。
这里只做最小可用的一件事——把事件写成一行一个 JSON 对象，追加到
``<data_dir>/logs/agent.jsonl``，并用固定字段（ts / event / level）便于 grep 与
后续导入分析工具。

设计约束：
- **日志失败绝不影响业务流程**：写不进去就静默降级（但会在返回结构里标记一行失败）；
- 不记录内容正文，只记录 id、计数、耗时、结果状态，避免把隐私写进日志。
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional


class JsonlLogger:
    def __init__(
        self,
        path: str | Path | None,
        *,
        enabled: bool = True,
        level: str = "INFO",
        max_bytes: int = 8 * 1024 * 1024,
    ) -> None:
        self.path = Path(path) if path else None
        self.enabled = bool(enabled and self.path)
        self.level = (level or "INFO").upper()
        self.max_bytes = max(64 * 1024, int(max_bytes))
        self.failures = 0

    # ------------------------------------------------------------------ #
    def _rotate_if_needed(self) -> None:
        if not self.path or not self.path.exists():
            return
        try:
            if self.path.stat().st_size >= self.max_bytes:
                backup = self.path.with_suffix(self.path.suffix + ".1")
                os.replace(self.path, backup)
        except OSError:  # pragma: no cover - 依赖文件系统
            pass

    def log(self, event: str, level: str = "INFO", **fields: Any) -> Optional[Dict[str, Any]]:
        """写一条事件；永远不抛异常。"""

        record: Dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
            "level": (level or "INFO").upper(),
            "event": str(event),
            **{key: value for key, value in fields.items() if value is not None},
        }
        if not self.enabled or self.path is None:
            return record
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._rotate_if_needed()
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
        except Exception:  # noqa: BLE001 - 日志失败不能影响业务
            self.failures += 1
            return None
        return record

    # ------------------------------------------------------------------ #
    def read(self, limit: int = 200) -> List[Dict[str, Any]]:
        if not self.path or not self.path.exists():
            return []
        rows: List[Dict[str, Any]] = []
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rows.append(json.loads(line))
                    except ValueError:
                        continue
        except OSError:
            return rows
        return rows[-limit:]

    def stats(self) -> Dict[str, Any]:
        entries = 0
        size = 0
        if self.path and self.path.exists():
            try:
                size = self.path.stat().st_size
                with self.path.open("r", encoding="utf-8") as handle:
                    entries = sum(1 for line in handle if line.strip())
            except OSError:
                pass
        return {"enabled": self.enabled, "entries": entries, "bytes": size, "failures": self.failures}


def build_logger(config: Any, data_dir: str | Path) -> JsonlLogger:
    """按配置构造日志器（file 为空时用 data_dir/logs/agent.jsonl）。"""

    logging_cfg = getattr(config, "logging", None)
    enabled = bool(getattr(logging_cfg, "jsonl", True)) if logging_cfg else True
    level = getattr(logging_cfg, "level", "INFO") if logging_cfg else "INFO"
    explicit = getattr(logging_cfg, "file", "") if logging_cfg else ""
    path = Path(explicit) if explicit else Path(data_dir) / "logs" / "agent.jsonl"
    return JsonlLogger(path, enabled=enabled, level=level)


__all__ = ["JsonlLogger", "build_logger"]
