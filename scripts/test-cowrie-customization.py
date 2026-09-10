import importlib.util
import random
import sys
import tempfile
import types
from pathlib import Path


class Config:
    state_path = ""

    @classmethod
    def get(cls, section, key, fallback=None):
        values = {
            ("honeypot", "auth_class_parameters"): "450,550",
            ("honeypot", "state_path"): cls.state_path,
        }
        return values.get((section, key), fallback)


class Protocol:
    def lineReceived(self, line):
        self.lines.append(line)

    def getProtoTransport(self):
        return self.transport


class Transport:
    def __init__(self):
        self.close_count = 0

    def loseConnection(self):
        self.close_count += 1


def load_customization():
    auth = types.ModuleType("cowrie.core.auth")
    config = types.ModuleType("cowrie.core.config")
    config.CowrieConfig = Config
    protocol = types.ModuleType("cowrie.shell.protocol")
    protocol.HoneyPotBaseProtocol = Protocol
    cowrie = types.ModuleType("cowrie")
    cowrie.__path__ = []
    core = types.ModuleType("cowrie.core")
    core.__path__ = []
    core.auth = auth
    shell = types.ModuleType("cowrie.shell")
    shell.__path__ = []
    sys.modules.update(
        {
            "cowrie": cowrie,
            "cowrie.core": core,
            "cowrie.core.auth": auth,
            "cowrie.core.config": config,
            "cowrie.shell": shell,
            "cowrie.shell.protocol": protocol,
        }
    )
    spec = importlib.util.spec_from_file_location(
        "neonhive_customization", "deploy/sitecustomize.py"
    )
    module = importlib.util.module_from_spec(spec)
    if spec.loader is None:
        raise RuntimeError("Could not load Cowrie customization")
    spec.loader.exec_module(module)
    return auth


with tempfile.TemporaryDirectory() as state_path:
    Config.state_path = state_path
    random.randint = lambda _minimum, _maximum: 450
    auth_module = load_customization()
    policy = auth_module.AuthGlobal()
    accepted = [
        policy.checklogin(b"user", str(attempt).encode(), f"192.0.2.{attempt % 250}")
        for attempt in range(900)
    ]
    assert [index + 1 for index, result in enumerate(accepted) if result] == [450, 900]

protocol = Protocol()
protocol.lines = []
protocol.transport = Transport()
for command in range(11):
    protocol.lineReceived(str(command).encode())
assert len(protocol.lines) == 10
assert protocol.transport.close_count == 1
