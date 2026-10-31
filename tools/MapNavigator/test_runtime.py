import ctypes
import importlib
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import runtime


class InstallDirOverrideTest(unittest.TestCase):
    def test_mapnav_install_dir_overrides_the_repo_install_dir(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.dict(os.environ, {"MAPNAV_INSTALL_DIR": temp_dir}):
                reloaded = importlib.reload(runtime)

            self.assertEqual(reloaded.INSTALL_DIR, Path(temp_dir).resolve())
            self.assertEqual(reloaded.AGENT_DIR, Path(temp_dir).resolve() / "agent")
            self.assertEqual(reloaded.MAAFW_BIN_DIR, Path(temp_dir).resolve() / "maafw")

        # 其他测试继续使用默认路径
        importlib.reload(runtime)


class MaaRuntimeLoadingTest(unittest.TestCase):
    @unittest.skipUnless(hasattr(ctypes, "RTLD_GLOBAL"), "requires POSIX dynamic loading")
    def test_linux_exports_framework_symbols_globally(self) -> None:
        modules = {
            "maa.agent_client": SimpleNamespace(AgentClient=Mock()),
            "maa.controller": SimpleNamespace(
                Win32Controller=Mock(), AdbController=Mock(), PlayCoverController=Mock(), LinuxController=Mock()
            ),
            "maa.library": SimpleNamespace(Library=Mock()),
            "maa.resource": SimpleNamespace(Resource=Mock()),
            "maa.tasker": SimpleNamespace(Tasker=Mock()),
            "maa.toolkit": SimpleNamespace(Toolkit=Mock()),
        }
        for platform in ("linux", "win32", "darwin"):
            with (
                self.subTest(platform=platform),
                patch.dict("sys.modules", modules),
                patch.object(runtime.sys, "platform", platform),
                patch.object(runtime, "MAAFW_BIN_DIR") as binary_dir,
                patch.object(runtime.ctypes, "CDLL") as load_library,
            ):
                library_path = binary_dir.__truediv__.return_value
                library_path.exists.return_value = True
                self.assertIsNotNone(runtime.load_maa_runtime())
                if platform == "linux":
                    load_library.assert_called_once_with(str(library_path), mode=ctypes.RTLD_GLOBAL)
                else:
                    load_library.assert_not_called()


if __name__ == "__main__":
    unittest.main()
