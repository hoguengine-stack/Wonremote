import sys
import json
import platform
import subprocess
import os
import ctypes

# DPI awareness 설정 (125%/150% 스케일링에서 좌표 오차 방지)
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # Per-monitor DPI aware
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

try:
    import pyautogui
except ImportError:
    sys.stderr.write("pyautogui not found. Please ensure it is installed or bundled.\n")
    sys.exit(1)

# 안전장치 해제 (화면 구석으로 가도 멈추지 않게)
pyautogui.FAILSAFE = False

# ⚠️ pyautogui 기본 지연 제거
# - pyautogui는 기본적으로 각 호출 사이에 PAUSE(기본 0.1s)가 걸릴 수 있어
#   마우스 move가 "엄청 느리게" 따라오는 증상의 주 원인이 됩니다.
pyautogui.PAUSE = 0
try:
    pyautogui.MINIMUM_DURATION = 0
    pyautogui.MINIMUM_SLEEP = 0
except Exception:
    pass

pressed_keys = set()
pressed_buttons = set()


def _get_virtual_screen_bounds():
    user32 = ctypes.windll.user32
    SM_XVIRTUALSCREEN = 76
    SM_YVIRTUALSCREEN = 77
    SM_CXVIRTUALSCREEN = 78
    SM_CYVIRTUALSCREEN = 79
    x0 = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
    y0 = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    w = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
    h = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    return x0, y0, w, h


def _clamp01(v):
    try:
        v = float(v)
    except Exception:
        return 0.0
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)


def _norm_to_screen_xy(xn, yn):
    x0, y0, w, h = _get_virtual_screen_bounds()
    xn = _clamp01(xn)
    yn = _clamp01(yn)
    x = x0 + int(xn * (w - 1))
    y = y0 + int(yn * (h - 1))
    return x, y


def _map_button(btn):
    # JS MouseEvent.button: 0=left, 1=middle, 2=right
    return 'left' if btn == 0 else ('middle' if btn == 1 else 'right')

def _normalize_key(k):
    if not k:
        return ''
    key = str(k)
    if key == ' ':
        return 'space'
    if key in ('Control', 'Ctrl'):
        return 'ctrl'
    if key in ('Shift',):
        return 'shift'
    if key in ('Alt', 'AltGraph'):
        return 'alt'
    if key in ('Meta', 'Win', 'OS', 'Windows', 'winleft', 'lwin'):
        return 'winleft'
    if key in ('Escape', 'Esc'):
        return 'esc'
    if key in ('ArrowUp',):
        return 'up'
    if key in ('ArrowDown',):
        return 'down'
    if key in ('ArrowLeft',):
        return 'left'
    if key in ('ArrowRight',):
        return 'right'
    if key in ('PageUp',):
        return 'pageup'
    if key in ('PageDown',):
        return 'pagedown'
    if key in ('Backspace',):
        return 'backspace'
    if key in ('Enter',):
        return 'enter'
    if key in ('Tab',):
        return 'tab'
    if key in ('Delete', 'Del'):
        return 'delete'
    if key in ('Insert',):
        return 'insert'
    if key in ('Home',):
        return 'home'
    if key in ('End',):
        return 'end'
    if key in ('CapsLock',):
        return 'capslock'
    if key in ('NumLock',):
        return 'numlock'
    if key in ('PrintScreen',):
        return 'printscreen'
    return key.lower()

def handle_command(line):
    try:
        data = json.loads(line)
        action = data.get('action')
        
        if action == 'mouse':
            type = data.get('type')

            # 우선 x/y(절대 좌표)가 있으면 이를 사용
            if data.get('x') is not None and data.get('y') is not None:
                x = data.get('x')
                y = data.get('y')
            elif data.get('xn') is not None and data.get('yn') is not None:
                x, y = _norm_to_screen_xy(data.get('xn'), data.get('yn'))
            else:
                x = None
                y = None

            if x is None or y is None:
                return

            if type == 'mousemove':
                # mousemove는 지연 없는 WinAPI로 즉시 이동
                ctypes.windll.user32.SetCursorPos(int(x), int(y))
            elif type == 'mousedown':
                ctypes.windll.user32.SetCursorPos(int(x), int(y))
                pyautogui.mouseDown(button=_map_button(data.get('button')))
                pressed_buttons.add(data.get('button'))
            elif type == 'mouseup':
                ctypes.windll.user32.SetCursorPos(int(x), int(y))
                pyautogui.mouseUp(button=_map_button(data.get('button')))
                pressed_buttons.discard(data.get('button'))
            elif type == 'wheel':
                dy = data.get('deltaY') or 0
                clicks = int(-float(dy) / 120) if dy else 0  # 스크롤 방향/스케일 조정
                if clicks != 0:
                    pyautogui.scroll(clicks)
                
        elif action in ('keyboard', 'key'):
            key = _normalize_key(data.get('key') or '')
            event_type = (data.get('type') or '').lower()

            if event_type in ('keydown', 'down'):
                if key:
                    pyautogui.keyDown(key)
                    pressed_keys.add(key)
            elif event_type in ('keyup', 'up'):
                if key:
                    pyautogui.keyUp(key)
                    pressed_keys.discard(key)
            else:
                if key:
                    pyautogui.press(key)
        elif action == 'paste':
            pyautogui.hotkey('ctrl', 'v')
        elif action == 'key_release_all':
            for k in list(pressed_keys):
                try:
                    pyautogui.keyUp(k)
                except Exception:
                    pass
            pressed_keys.clear()
        elif action == 'system':
            command = (data.get('command') or '').lower()
            # 윈도우 전용 빠른 실행/전원 제어
            if platform.system().lower() != 'windows':
                return

            def run_detached(cmd_list):
                try:
                    subprocess.Popen(cmd_list, creationflags=subprocess.DETACHED_PROCESS)
                except Exception:
                    pass

            if command in ('services', 'services.msc'):
                run_detached(['cmd', '/c', 'start', 'services.msc'])
            elif command in ('taskmgr', 'taskmanager'):
                run_detached(['cmd', '/c', 'start', 'taskmgr'])
            elif command == 'cmd':
                run_detached(['cmd', '/c', 'start', 'cmd'])
            elif command == 'explorer':
                run_detached(['cmd', '/c', 'start', 'explorer'])
            elif command in ('devmgmt', 'devmgmt.msc'):
                run_detached(['cmd', '/c', 'start', 'devmgmt.msc'])
            elif command == 'lock':
                run_detached(['rundll32.exe', 'user32.dll,LockWorkStation'])
            elif command == 'logoff':
                run_detached(['shutdown', '/l'])
            elif command == 'restart':
                run_detached(['shutdown', '/r', '/t', '0'])
            elif command == 'shutdown':
                run_detached(['shutdown', '/s', '/t', '0'])

    except Exception as e:
        # 에러 무시 (계속 실행)
        pass

if __name__ == "__main__":
    # 표준 입력(stdin)으로 계속 명령을 받음
    for line in sys.stdin:
        handle_command(line)
