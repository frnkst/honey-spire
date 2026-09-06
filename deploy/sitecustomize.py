import fcntl
import json
import os
import random
from pathlib import Path

from cowrie.core import auth
from cowrie.core.config import CowrieConfig
from cowrie.shell.protocol import HoneyPotBaseProtocol


class AuthGlobal:
    """Accept one global password attempt after each randomized interval."""

    def __init__(self) -> None:
        parameters = CowrieConfig.get(
            "honeypot", "auth_class_parameters", fallback="450,550"
        )
        minimum, maximum = (int(value.strip()) for value in parameters.split(",", 1))
        self.minimum = max(1, minimum)
        self.maximum = max(self.minimum, maximum)
        self.state_file = Path(
            CowrieConfig.get("honeypot", "state_path")
        ) / "auth_global.json"

    def checklogin(self, thelogin: bytes, thepasswd: bytes, src_ip: str) -> bool:
        del thelogin, thepasswd, src_ip
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.state_file, os.O_RDWR | os.O_CREAT, 0o600)
        with os.fdopen(fd, "r+", encoding="utf-8") as state_handle:
            fcntl.flock(state_handle, fcntl.LOCK_EX)
            raw_state = state_handle.read()
            state = json.loads(raw_state) if raw_state else {}
            attempts = int(state.get("attempts", 0)) + 1
            next_accept = int(
                state.get(
                    "next_accept",
                    random.randint(self.minimum, self.maximum),
                )
            )
            accepted = attempts >= next_accept
            if accepted:
                next_accept = attempts + random.randint(
                    self.minimum, self.maximum
                )
            state_handle.seek(0)
            json.dump(
                {
                    "attempts": attempts,
                    "next_accept": next_accept,
                },
                state_handle,
            )
            state_handle.truncate()
            return accepted


auth.AuthGlobal = AuthGlobal

_original_line_received = HoneyPotBaseProtocol.lineReceived


def _limited_line_received(self, line: bytes) -> None:
    if getattr(self, "_honey_spire_command_limit_reached", False):
        return
    command_count = getattr(self, "_honey_spire_command_count", 0) + 1
    self._honey_spire_command_count = command_count
    _original_line_received(self, line)
    if command_count == 10:
        self._honey_spire_command_limit_reached = True
        self.getProtoTransport().loseConnection()


HoneyPotBaseProtocol.lineReceived = _limited_line_received
