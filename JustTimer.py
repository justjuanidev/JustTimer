import tkinter as tk
from datetime import datetime, timedelta
import os, sys, traceback, threading, subprocess
try:
    import winsound
    _HAS_WINSOUND = True
except ImportError:
    _HAS_WINSOUND = False

# ── Versión de la app ──────────────────────────────────────────
APP_VERSION = "1.2.0"
GITHUB_USER = "justjuanidev"       # ← cambiar
GITHUB_REPO = "JustTimerPlus"  # ← cambiar

def _check_update_available():
    """Consulta la última release en GitHub. Devuelve (version, url) o (None, None)."""
    try:
        import urllib.request, json
        url = f"https://api.github.com/repos/{GITHUB_USER}/{GITHUB_REPO}/releases/latest"
        req = urllib.request.Request(url, headers={"User-Agent": "focusmate-timer"})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read())
        latest = data.get("tag_name", "").lstrip("v")
        assets = data.get("assets", [])
        exe_url = next((a["browser_download_url"] for a in assets
                if a["name"].endswith(".exe")), None)
        if latest and exe_url and latest != APP_VERSION:
            return latest, exe_url

    except Exception:
        pass
    return None, None

def _download_and_replace(exe_url, on_progress=None, on_done=None, on_error=None):
    """Descarga el nuevo .exe y arma un script batch que reemplaza al cerrar."""
    try:
        import urllib.request
        dest_dir = os.path.dirname(sys.executable if getattr(sys, "frozen", False)
                                   else os.path.abspath(__file__))
        new_exe  = os.path.join(dest_dir, "_update_new.exe")
        current  = sys.executable if getattr(sys, "frozen", False) else None

        def _reporthook(count, block, total):
            if on_progress and total > 0:
                pct = min(100, int(count * block * 100 / total))
                on_progress(pct)

        urllib.request.urlretrieve(exe_url, new_exe, _reporthook)
        if on_progress:
            on_progress(100)

        if current:
            bat = os.path.join(dest_dir, "_update.bat")
            bat_content = (
                "@echo off\n"
                "ping 127.0.0.1 -n 3 > nul\n"
                f'move /y "{new_exe}" "{current}"\n'
                f'start "" "{current}"\n'
                'del "%~f0"\n'
            )
            with open(bat, "w") as f:
                f.write(bat_content)
            if on_done:
                on_done(bat)
        else:
            if on_done:
                on_done(None)
    except Exception as e:
        if on_error:
            on_error(str(e))

# Sonidos: busca automaticamente en la carpeta "sonidos/" al lado del .exe o .py
def _resolve_sound(filename):
    import sys
    base = os.path.dirname(sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__))
    path = os.path.join(base, "sonidos", filename)
    return path if os.path.exists(path) else None

SOUND_START     = _resolve_sound("start.wav")
SOUND_END       = _resolve_sound("end.wav")
SOUND_TASK_DONE = _resolve_sound("task_done.wav")
SOUND_ALL_DONE  = _resolve_sound("all_done.wav")
SOUND_WARN      = _resolve_sound("warn.wav")

# ── Paleta de energía (1=rojo → 5=naranja → 10=verde) ──────────
def _energy_color(level):
    """Devuelve (bg, fg) para un nivel de energía 1-10."""
    colors = {
        1:  ("#5c0a0a", "#ff4444"),
        2:  ("#6e1a08", "#ff6633"),
        3:  ("#7a2e05", "#ff8833"),
        4:  ("#7a4a00", "#ffaa22"),
        5:  ("#6b5500", "#ffcc00"),
        6:  ("#4a5c00", "#ccdd00"),
        7:  ("#2e6010", "#88dd22"),
        8:  ("#1a6622", "#44cc44"),
        9:  ("#0d6b30", "#22dd66"),
        10: ("#0a5c3a", "#00ffaa"),
    }
    return colors.get(level, ("#1e1e1e", "#888888"))

# ── Carpeta de sesiones ────────────────────────────────────────
def _sessions_base():
    """Carpeta raíz donde se guardan las sesiones."""
    base = os.path.dirname(sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__))
    return os.path.join(base, "sesiones")

# ── Paleta ─────────────────────────────────────────────────────
BG         = "#0f0f0f"
FG_TIME    = "#f0f0f0"
FG_DIM     = "#555555"
ACCENT     = "#2e53cc"
FG_WARN    = "#ff3333"   # rojo para el ultimo minuto
WARN_SECS  = 60          # segundos antes de inicio/fin para avisar
BTN_BG     = "#1e1e1e"
BTN_HOVER  = "#2a2a2a"
FONT_BIG   = ("Courier New", 36, "bold")
FONT_MED   = ("Courier New", 20, "bold")
FONT_SMALL = ("Courier New", 9)

DEFAULT_SESSIONS = [25, 50, 75]

def fmt_hour(dt):
    """HH:MM sin cero inicial, compatible Windows y Linux."""
    h = dt.hour
    m = dt.minute
    return f"{h}:{m:02d}"

def next_quarters(n=6):
    """Devuelve los 2 cuartos anteriores (hasta 30 min atras) + n futuros."""
    now = datetime.now()
    past_mins = now.minute - (now.minute % 15)
    current = now.replace(second=0, microsecond=0, minute=0) + timedelta(minutes=past_mins)
    prev = current - timedelta(minutes=15)
    future_base = current + timedelta(minutes=15)
    futures = [future_base + timedelta(minutes=15*i) for i in range(n)]
    return [prev, current] + futures


class JustTimer:
    def __init__(self, root, taskbar_root=None):
        self.root = root
        self.taskbar_root = taskbar_root or root
        self.root.title("")
        self.root.configure(bg=BG)
        self.root.resizable(False, False)
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", 0.93)
        self.root.overrideredirect(True)
        self._icon_tmp = None

        self._duration_secs = 0
        self._remaining     = 0
        self._total         = 0
        self._running       = False
        self._job           = None
        self._drag_x = self._drag_y = 0
        self._start_at      = None   # cuando arranca el timer (datetime)
        self._end_at        = None   # cuando termina el timer (datetime)
        self._waiting       = False
        self._session_tasks = []     # lista de {"text": str, "done": BooleanVar}
        self._tasks_window  = None   # referencia a la ventana flotante de tareas

        self._build_ui()
        self._show_setup()
        self._center_window()

    # ════════════════════════════════════════════════════════════
    # BUILD UI
    # ════════════════════════════════════════════════════════════
    @staticmethod
    def _play_sound(kind):
        """kind: 'start' | 'end' | 'task_done' | 'all_done' | 'warn'"""
        sound_map = {
            "start":     SOUND_START,
            "end":       SOUND_END,
            "task_done": SOUND_TASK_DONE,
            "all_done":  SOUND_ALL_DONE,
            "warn":      SOUND_WARN,
        }
        custom = sound_map.get(kind)
        if _HAS_WINSOUND:
            try:
                if custom and os.path.exists(custom):
                    winsound.PlaySound(custom, winsound.SND_FILENAME | winsound.SND_ASYNC)
                elif kind == "start":
                    winsound.MessageBeep(winsound.MB_ICONASTERISK)
                elif kind == "end":
                    winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
                elif kind in ("task_done", "all_done", "warn"):
                    winsound.MessageBeep(winsound.MB_OK)
            except Exception:
                pass

    def _build_ui(self):
        # Drag bar
        drag = tk.Frame(self.root, bg="#1a1a1a", cursor="fleur", height=14)
        drag.pack(fill="x")
        drag.bind("<ButtonPress-1>", self._drag_start)
        drag.bind("<B1-Motion>",     self._drag_move)
        x_btn = tk.Label(drag, text="✕", bg="#1a1a1a", fg="#444",
                         font=FONT_SMALL, cursor="hand2")
        x_btn.place(relx=1.0, rely=0.5, anchor="e", x=-6)
        x_btn.bind("<Button-1>", lambda e: self._cleanup_and_quit())
        x_btn.bind("<Enter>",    lambda e: x_btn.config(fg="#ff4444"))
        x_btn.bind("<Leave>",    lambda e: x_btn.config(fg="#444"))

        # ── PANEL SETUP ─────────────────────────────────────────
        self.setup_frame = tk.Frame(self.root, bg=BG)

        tk.Label(self.setup_frame, text="duración", bg=BG, fg=FG_DIM,
                 font=FONT_SMALL).pack(pady=(10, 2))

        dur_row = tk.Frame(self.setup_frame, bg=BG)
        dur_row.pack()
        self.dur_buttons = {}
        for mins in DEFAULT_SESSIONS:
            btn = tk.Button(
                dur_row, text=f"{mins}'",
                bg=BTN_BG, fg=FG_DIM,
                activebackground=BTN_HOVER, activeforeground=FG_TIME,
                relief="flat", bd=0, font=FONT_SMALL,
                padx=10, pady=4, cursor="hand2",
                command=lambda m=mins: self._select_duration(m),
            )
            btn.pack(side="left", padx=3)
            btn.bind("<Enter>", lambda e, b=btn: b.config(bg=BTN_HOVER, fg=FG_TIME))
            btn.bind("<Leave>", lambda e, b=btn, m=mins: b.config(
                bg=BTN_BG, fg=ACCENT if self._duration_secs == m*60 else FG_DIM))
            self.dur_buttons[mins] = btn

        # Custom duración
        cust_row = tk.Frame(self.setup_frame, bg=BG)
        cust_row.pack(pady=(4, 0))
        tk.Label(cust_row, text="otro:", bg=BG, fg=FG_DIM, font=FONT_SMALL).pack(side="left", padx=(6,2))
        vcmd = (self.root.register(lambda s: s.isdigit() or s == ""), "%P")
        self.cust_dur_var = tk.StringVar()
        cust_e = tk.Entry(cust_row, textvariable=self.cust_dur_var, width=4,
                          bg=BTN_BG, fg=FG_TIME, insertbackground=FG_TIME,
                          relief="flat", bd=0, font=FONT_SMALL, justify="center",
                          validate="key", validatecommand=vcmd)
        cust_e.pack(side="left", padx=2, ipady=3)
        cust_e.bind("<Return>", self._set_custom_duration)
        ok_d = tk.Button(cust_row, text="ok", bg=BTN_BG, fg=FG_DIM,
                         activebackground=BTN_HOVER, activeforeground=FG_TIME,
                         relief="flat", bd=0, font=FONT_SMALL,
                         padx=6, pady=3, cursor="hand2", command=self._set_custom_duration)
        ok_d.pack(side="left", padx=(2,6))
        ok_d.bind("<Enter>", lambda e: ok_d.config(bg=BTN_HOVER, fg=FG_TIME))
        ok_d.bind("<Leave>", lambda e: ok_d.config(bg=BTN_BG, fg=FG_DIM))

        tk.Frame(self.setup_frame, bg="#222", height=1).pack(fill="x", padx=12, pady=8)

        tk.Label(self.setup_frame, text="hora de inicio", bg=BG, fg=FG_DIM,
                 font=FONT_SMALL).pack(pady=(0,4))

        self.quarter_frame = tk.Frame(self.setup_frame, bg=BG)
        self.quarter_frame.pack()
        self._build_quarter_buttons()

        tk.Label(self.setup_frame, text="o ingresá la hora  HH:MM",
                 bg=BG, fg=FG_DIM, font=FONT_SMALL).pack(pady=(6,2))

        time_row = tk.Frame(self.setup_frame, bg=BG)
        time_row.pack(pady=(0,6))
        self.time_var = tk.StringVar()
        te = tk.Entry(time_row, textvariable=self.time_var, width=6,
                      bg=BTN_BG, fg=FG_TIME, insertbackground=FG_TIME,
                      relief="flat", bd=0, font=("Courier New", 11), justify="center")
        te.pack(side="left", padx=4, ipady=4)
        te.bind("<Return>", self._set_manual_time)
        go = tk.Button(time_row, text="programar",
                       bg=ACCENT, fg="#000",
                       activebackground="#91a7ed", activeforeground="#000",
                       relief="flat", bd=0, font=("Courier New", 9, "bold"),
                       padx=10, pady=4, cursor="hand2", command=self._set_manual_time)
        now_btn = tk.Button(self.setup_frame, text="iniciar ahora",
                    bg=BTN_BG, fg=FG_DIM,
                    activebackground=BTN_HOVER, activeforeground=FG_TIME,
                    relief="flat", bd=0, font=("Courier New", 9),
                    padx=10, pady=4, cursor="hand2",
                    command=lambda: self._schedule(datetime.now()))
        now_btn.pack(pady=(0, 4))
        now_btn.bind("<Enter>", lambda e: now_btn.config(bg=BTN_HOVER, fg=FG_TIME))
        now_btn.bind("<Leave>", lambda e: now_btn.config(bg=BTN_BG, fg=FG_DIM))
        go.pack(side="left", padx=4)

        self.setup_err = tk.Label(self.setup_frame, text="", bg=BG, fg="#ff6666",
                                  font=FONT_SMALL)
        self.setup_err.pack(pady=(0,4))

        # ── Tareas previas a la sesión ───────────────────────────
        tk.Frame(self.setup_frame, bg="#222", height=1).pack(fill="x", padx=12, pady=(0, 6))
        tk.Label(self.setup_frame, text="tareas para la sesión",
                 bg=BG, fg=FG_DIM, font=FONT_SMALL).pack(pady=(0, 4))

        # Frame contenedor de la lista
        self._setup_tasks_frame = tk.Frame(self.setup_frame, bg=BG)
        self._setup_tasks_frame.pack(fill="x", padx=12)

        # Input nueva tarea
        setup_input_row = tk.Frame(self.setup_frame, bg=BG)
        setup_input_row.pack(fill="x", padx=12, pady=(4, 2))

        self._setup_task_var = tk.StringVar()
        setup_task_entry = tk.Entry(setup_input_row, textvariable=self._setup_task_var,
                                    bg=BTN_BG, fg=FG_TIME, insertbackground=FG_TIME,
                                    relief="flat", bd=0, font=("Courier New", 9),
                                    justify="left")
        setup_task_entry.pack(side="left", fill="x", expand=True, ipady=3, padx=(0, 4))

        def _setup_add_task(event=None):
            text = self._setup_task_var.get().strip()
            if not text:
                return
            self._session_tasks.append({
                "text":           text,
                "done":           tk.BooleanVar(value=False),
                "completion_min": None,
                "notes":          "",        
            })
            self._setup_task_var.set("")
            _setup_refresh()

        setup_task_entry.bind("<Return>", _setup_add_task)

        setup_add_btn = tk.Button(setup_input_row, text="+ agregar",
                                  bg=BTN_BG, fg=FG_DIM,
                                  activebackground=BTN_HOVER, activeforeground=FG_TIME,
                                  relief="flat", bd=0, font=FONT_SMALL,
                                  padx=8, pady=3, cursor="hand2",
                                  command=_setup_add_task)
        setup_add_btn.pack(side="left")
        setup_add_btn.bind("<Enter>", lambda e: setup_add_btn.config(bg=BTN_HOVER, fg=FG_TIME))
        setup_add_btn.bind("<Leave>", lambda e: setup_add_btn.config(bg=BTN_BG, fg=FG_DIM))

        def _setup_refresh():
            for w in self._setup_tasks_frame.winfo_children():
                w.destroy()
            for i, task in enumerate(self._session_tasks):
                row = tk.Frame(self._setup_tasks_frame, bg=BG)
                row.pack(fill="x", pady=1)
                tk.Label(row, text="·", bg=BG, fg=ACCENT,
                         font=("Courier New", 9)).pack(side="left", padx=(2, 4))
                tk.Label(row, text=task["text"], bg=BG, fg=FG_TIME,
                         font=("Courier New", 9), anchor="w",
                         wraplength=180).pack(side="left", fill="x", expand=True)
                del_lbl = tk.Label(row, text="✕", bg=BG, fg="#333",
                                   font=("Courier New", 8), cursor="hand2")
                note_lbl = tk.Label(row, text="✎", bg=BG, fg="#555",
                    font=("Courier New", 8), cursor="hand2")
                note_lbl.pack(side="right", padx=(0, 2))
                note_lbl.bind("<Enter>", lambda e, b=note_lbl: b.config(fg=ACCENT))
                note_lbl.bind("<Leave>", lambda e, b=note_lbl: b.config(fg="#555"))
                note_lbl.bind("<Button-1>", lambda e, idx=i, b=note_lbl: _setup_open_notes(idx, b))
                del_lbl.pack(side="right", padx=(0, 2))
                del_lbl.bind("<Enter>", lambda e, b=del_lbl: b.config(fg="#ff4444"))
                del_lbl.bind("<Leave>", lambda e, b=del_lbl: b.config(fg="#333"))
                del_lbl.bind("<Button-1>", lambda e, idx=i: _setup_delete(idx))

        def _setup_delete(idx):
            if 0 <= idx < len(self._session_tasks):
                self._session_tasks.pop(idx)
                _setup_refresh()

        def _setup_open_notes(idx, btn):
            task = self._session_tasks[idx]
            dlg = tk.Toplevel(self.setup_frame)
            dlg.title("")
            dlg.configure(bg=BG)
            dlg.resizable(False, False)
            dlg.attributes("-topmost", True)
            sw2, sh2 = dlg.winfo_screenwidth(), dlg.winfo_screenheight()
            dlg.geometry(f"260x180+{(sw2-260)//2}+{(sh2-180)//2}")
            tk.Label(dlg, text=task["text"], bg=BG, fg=ACCENT,
                    font=("Courier New", 9, "bold"), wraplength=240).pack(pady=(10, 4))
            tk.Label(dlg, text="notas", bg=BG, fg=FG_DIM, font=FONT_SMALL).pack()
            txt = tk.Text(dlg, bg=BTN_BG, fg=FG_TIME, insertbackground=FG_TIME,
                        relief="flat", bd=0, font=("Courier New", 9),
                        width=30, height=5, wrap="word")
            txt.pack(padx=10, pady=4, fill="both", expand=True)
            txt.insert("1.0", task.get("notes", ""))
            txt.focus_set()
            def _save():
                task["notes"] = txt.get("1.0", "end-1c").strip()
                btn.config(fg=ACCENT if task["notes"] else "#555")
                dlg.destroy()
            tk.Button(dlg, text="guardar", bg=ACCENT, fg="#000",
                    activebackground="#d4ff33", activeforeground="#000",
                    relief="flat", bd=0, font=("Courier New", 9, "bold"),
                    padx=10, pady=4, cursor="hand2", command=_save).pack(pady=(0, 8))
            dlg.bind("<Return>", lambda e: _save())

        # Guardar referencia para poder refrescar desde _show_setup
        self._setup_refresh_fn = _setup_refresh

        # Botón calendario en setup
        cal_setup_btn = tk.Button(self.setup_frame, text="calendario",
                                  bg=BTN_BG, fg=FG_DIM,
                                  activebackground=BTN_HOVER, activeforeground=FG_TIME,
                                  relief="flat", bd=0, font=FONT_SMALL,
                                  padx=10, pady=4, cursor="hand2",
                                  command=self._show_calendar)
        cal_setup_btn.pack(pady=(4, 10))
        cal_setup_btn.bind("<Enter>", lambda e: cal_setup_btn.config(bg=BTN_HOVER, fg=FG_TIME))
        cal_setup_btn.bind("<Leave>", lambda e: cal_setup_btn.config(bg=BTN_BG, fg=FG_DIM))

        # ── Versión y actualizaciones ────────────────────────────
        ver_row = tk.Frame(self.setup_frame, bg=BG)
        ver_row.pack(pady=(0, 8))
        self._ver_label = tk.Label(ver_row, text=f"v{APP_VERSION}",
                                   bg=BG, fg="#333", font=FONT_SMALL)
        self._ver_label.pack(side="left", padx=(0, 6))
        self._upd_btn = tk.Label(ver_row, text="", bg=BG, fg=FG_DIM,
                                 font=FONT_SMALL, cursor="hand2")
        self._upd_btn.pack(side="left")
        self._upd_btn.bind("<Button-1>", lambda e: self._run_update())
        # Chequear en segundo plano al arrancar
        self.root.after(2000, self._bg_check_update)

        # ── PANEL ESPERA ────────────────────────────────────────
        self.wait_frame = tk.Frame(self.root, bg=BG)
        tk.Label(self.wait_frame, text="empieza en", bg=BG, fg=FG_DIM,
                 font=FONT_SMALL).pack(pady=(12,0))
        self.wait_label = tk.Label(self.wait_frame, text="--:--:--",
                                   bg=BG, fg=ACCENT, font=FONT_MED, padx=24, pady=4)
        self.wait_label.pack()
        self.wait_info = tk.Label(self.wait_frame, text="", bg=BG, fg=FG_DIM, font=FONT_SMALL)
        self.wait_info.pack()
        cancel_btn = tk.Button(self.wait_frame, text="cancelar",
                               bg=BTN_BG, fg=FG_DIM,
                               activebackground=BTN_HOVER, activeforeground=FG_TIME,
                               relief="flat", bd=0, font=FONT_SMALL,
                               padx=8, pady=4, cursor="hand2", command=self._show_setup)
        cancel_btn.pack(pady=(6,10))
        cancel_btn.bind("<Enter>", lambda e: cancel_btn.config(bg=BTN_HOVER, fg=FG_TIME))
        cancel_btn.bind("<Leave>", lambda e: cancel_btn.config(bg=BTN_BG, fg=FG_DIM))

        # ── PANEL TIMER ─────────────────────────────────────────
        self.timer_frame = tk.Frame(self.root, bg=BG)
        self.time_label = tk.Label(self.timer_frame, text="--:--",
                                   bg=BG, fg=FG_DIM, font=FONT_BIG, padx=24, pady=8)
        self.time_label.pack()
        self.prog_canvas = tk.Canvas(self.timer_frame, bg=BG,
                                     highlightthickness=0, width=180, height=3)
        self.prog_canvas.pack(pady=(0,8))
        self.prog_bar = self.prog_canvas.create_rectangle(0,0,0,3, fill=ACCENT, outline="")

        t_row = tk.Frame(self.timer_frame, bg=BG)
        t_row.pack(pady=(0,10))
        self.start_btn = tk.Button(t_row, text="||",
                                   bg=ACCENT, fg="#000",
                                   activebackground="#91a7ed", activeforeground="#000",
                                   relief="flat", bd=0, font=("Courier New", 9, "bold"),
                                   padx=10, pady=4, cursor="hand2", command=self._toggle)
        self.start_btn.pack(side="left", padx=4)
        rst = tk.Button(t_row, text="reset",
                        bg=BTN_BG, fg=FG_DIM,
                        activebackground=BTN_HOVER, activeforeground=FG_TIME,
                        relief="flat", bd=0, font=FONT_SMALL,
                        padx=8, pady=4, cursor="hand2", command=self._reset)
        rst.pack(side="left", padx=4)
        rst.bind("<Enter>", lambda e: rst.config(bg=BTN_HOVER, fg=FG_TIME))
        rst.bind("<Leave>", lambda e: rst.config(bg=BTN_BG, fg=FG_DIM))
        edt = tk.Button(t_row, text="editar",
                        bg=BTN_BG, fg=FG_DIM,
                        activebackground=BTN_HOVER, activeforeground=FG_TIME,
                        relief="flat", bd=0, font=FONT_SMALL,
                        padx=8, pady=4, cursor="hand2", command=self._show_setup)
        edt.pack(side="left", padx=4)
        edt.bind("<Enter>", lambda e: edt.config(bg=BTN_HOVER, fg=FG_TIME))
        edt.bind("<Leave>", lambda e: edt.config(bg=BTN_BG, fg=FG_DIM))
        hist = tk.Button(t_row, text="cal",
                         bg=BTN_BG, fg=FG_DIM,
                         activebackground=BTN_HOVER, activeforeground=FG_TIME,
                         relief="flat", bd=0, font=FONT_SMALL,
                         padx=8, pady=4, cursor="hand2", command=self._show_calendar)
        hist.pack(side="left", padx=4)
        hist.bind("<Enter>", lambda e: hist.config(bg=BTN_HOVER, fg=FG_TIME))
        hist.bind("<Leave>", lambda e: hist.config(bg=BTN_BG, fg=FG_DIM))

        self.tasks_btn = tk.Button(t_row, text="tareas",
                         bg=BTN_BG, fg=FG_DIM,
                         activebackground=BTN_HOVER, activeforeground=FG_TIME,
                         relief="flat", bd=0, font=FONT_SMALL,
                         padx=8, pady=4, cursor="hand2", command=self._show_tasks_window)
        self.tasks_btn.pack(side="left", padx=4)
        self.tasks_btn.bind("<Enter>", lambda e: self.tasks_btn.config(bg=BTN_HOVER, fg=FG_TIME))
        self.tasks_btn.bind("<Leave>", lambda e: self.tasks_btn.config(bg=BTN_BG, fg=FG_DIM))

    def _build_quarter_buttons(self):
        for w in self.quarter_frame.winfo_children():
            w.destroy()
        now = __import__("datetime").datetime.now()
        quarters = next_quarters(6)
        for i, t in enumerate(quarters):
            is_past = t <= now
            lbl = fmt_hour(t) + (" *" if is_past else "")
            fg  = "#ff9900" if is_past else FG_DIM   # naranja = ya empezo
            btn = tk.Button(
                self.quarter_frame, text=lbl,
                bg=BTN_BG, fg=fg,
                activebackground=BTN_HOVER, activeforeground=FG_TIME,
                relief="flat", bd=0, font=FONT_SMALL,
                padx=7, pady=3, cursor="hand2",
                command=lambda dt=t: self._schedule(dt),
            )
            btn.grid(row=i//3, column=i%3, padx=3, pady=2)
            btn.bind("<Enter>", lambda e, b=btn: b.config(bg=BTN_HOVER, fg=FG_TIME))
            btn.bind("<Leave>", lambda e, b=btn, f=fg: b.config(bg=BTN_BG, fg=f))

    # ════════════════════════════════════════════════════════════
    # VISTAS
    # ════════════════════════════════════════════════════════════
    def _show_setup(self):
        self._session_tasks = []
        self._cancel_job()
        self._waiting = False
        self._running = False
        self.wait_frame.pack_forget()
        self.timer_frame.pack_forget()
        self._build_quarter_buttons()
        self.setup_frame.pack()
        # Refrescar lista de tareas previas
        if hasattr(self, "_setup_refresh_fn"):
            self._setup_refresh_fn()
        self.root.update_idletasks()

    def _show_wait(self):
        self.setup_frame.pack_forget()
        self.timer_frame.pack_forget()
        self.wait_frame.pack()
        self.root.update_idletasks()

    def _show_timer(self):
        self.setup_frame.pack_forget()
        self.wait_frame.pack_forget()
        self.timer_frame.pack()
        self.root.update_idletasks()

    # ════════════════════════════════════════════════════════════
    # DURACIÓN
    # ════════════════════════════════════════════════════════════
    def _select_duration(self, mins):
        self._duration_secs = mins * 60
        for m, btn in self.dur_buttons.items():
            btn.config(fg=ACCENT if m == mins else FG_DIM)
        self.setup_err.config(text="")

    def _set_custom_duration(self, event=None):
        val = self.cust_dur_var.get().strip()
        if not val:
            return
        mins = int(val)
        if mins <= 0:
            return
        self._duration_secs = mins * 60
        for btn in self.dur_buttons.values():
            btn.config(fg=FG_DIM)
        self.cust_dur_var.set("")
        self.setup_err.config(text="")

    # ════════════════════════════════════════════════════════════
    # PROGRAMAR INICIO
    # ════════════════════════════════════════════════════════════
    def _schedule(self, start_dt):
        if not self._duration_secs:
            self.setup_err.config(text="primero elegí la duración")
            return
        now = datetime.now()
        end_dt = start_dt + timedelta(seconds=self._duration_secs)

        if start_dt <= now:
            # ya pasó la hora de inicio
            if (now - start_dt).total_seconds() > 1800:
                self.setup_err.config(text="pasaron mas de 30 min del inicio")
                return
            # arranca directo con el tiempo restante
            self._start_at  = start_dt
            self._end_at    = end_dt
            self._total     = self._duration_secs
            elapsed = int((now - start_dt).total_seconds())
            self._remaining = self._duration_secs - elapsed
            self.setup_err.config(text="")
            self._show_timer()
            self._update_display()
            self._start()
            return

        # inicio en el futuro → modo espera normal
        self._start_at  = start_dt
        self._end_at    = end_dt
        self._total     = self._duration_secs
        self._remaining = self._duration_secs
        self.setup_err.config(text="")
        self.wait_info.config(
            text=f"{self._duration_secs // 60} min  ·  {fmt_hour(start_dt)}")
        self._waiting = True
        self._show_wait()
        self._tick_wait()

    def _set_manual_time(self, event=None):
        raw = self.time_var.get().strip()
        self.time_var.set("")
        try:
            today = datetime.now().date()
            parsed = datetime.strptime(raw, "%H:%M").replace(
                year=today.year, month=today.month, day=today.day)
            if parsed <= datetime.now():
                parsed += timedelta(days=1)
            self._schedule(parsed)
        except ValueError:
            self.setup_err.config(text="formato: HH:MM  (ej. 19:15)")

    # ════════════════════════════════════════════════════════════
    # TICK ESPERA
    # ════════════════════════════════════════════════════════════
    def _tick_wait(self):
        if not self._waiting:
            return
        delta = (self._start_at - datetime.now()).total_seconds()
        if delta <= 0:
            self._waiting = False
            self._show_timer()
            self._update_display()
            self._start()
            return
        h = int(delta // 3600)
        m = int((delta % 3600) // 60)
        s = int(delta % 60)
        was_ok = not getattr(self, "_wait_warned", False)
        warn_now = delta <= WARN_SECS
        if warn_now and was_ok:
            self._wait_warned = True
            self._play_sound("warn")
        elif not warn_now:
            self._wait_warned = False
        warn_color = FG_WARN if warn_now else ACCENT
        self.wait_label.config(text=f"{h:02d}:{m:02d}:{s:02d}", fg=warn_color)
        if 59 <= int(delta) <= 61:
            self._play_sound("start")
        self._job = self.root.after(1000, self._tick_wait)

    # ════════════════════════════════════════════════════════════
    # TIMER
    # ════════════════════════════════════════════════════════════
    def _toggle(self):
        if self._end_at is None:
            return
        if self._running:
            # pausar: guardar cuánto queda
            self._pause_remaining = max(0, int((self._end_at - datetime.now()).total_seconds()))
            self._stop_timer()
            self.start_btn.config(text=">")
        else:
            # reanudar: recalcular end_at desde ahora
            remaining = getattr(self, "_pause_remaining", self._total)
            self._end_at = datetime.now() + timedelta(seconds=remaining)
            self._start()

    def _start(self):
        self._running = True
        self._pause_remaining = None
        self.start_btn.config(text="||")
        self._play_sound("start")
        self._tick_timer()

    def _stop_timer(self):
        self._running = False
        self._cancel_job()

    def _reset(self):
        self._stop_timer()
        # recalcular end_at como si arrancara ahora
        self._end_at = datetime.now() + timedelta(seconds=self._total)
        self._pause_remaining = self._total
        self.start_btn.config(text=">")
        self._remaining = self._total
        self._update_display()

    def _cancel_job(self):
        if self._job:
            self.root.after_cancel(self._job)
            self._job = None

    def _tick_timer(self):
        if not self._running:
            return
        remaining = max(0, int((self._end_at - datetime.now()).total_seconds()))
        self._remaining = remaining

        # Sonido de advertencia al entrar en el último minuto
        was_ok = not getattr(self, "_timer_warned", False)
        warn_now = 0 < remaining <= WARN_SECS
        if warn_now and was_ok:
            self._timer_warned = True
            self._play_sound("warn")
        elif not warn_now:
            self._timer_warned = False

        self._update_display()
        if remaining > 0:
            # despertar ~100ms antes del próximo segundo exacto para no saltear
            self._job = self.root.after(500, self._tick_timer)
        else:
            self._running = False
            self.start_btn.config(text=">")
            self.time_label.config(fg=ACCENT, text="00:00")
            self._play_sound("end")
            self.root.after(300, self._show_log_dialog)

    def _update_display(self):
        m, s = self._remaining // 60, self._remaining % 60
        if self._remaining <= 0:
            fg = ACCENT
        elif self._remaining <= WARN_SECS:
            fg = FG_WARN
        else:
            fg = FG_TIME
        self.time_label.config(text=f"{m:02d}:{s:02d}", fg=fg)
        if self._total > 0:
            ratio = 1 - (self._remaining / self._total)
            self.prog_canvas.coords(self.prog_bar, 0, 0, int(180*ratio), 3)

    # ════════════════════════════════════════════════════════════
    # VENTANA DE TAREAS
    # ════════════════════════════════════════════════════════════
    def _show_tasks_window(self):
        """Ventana flotante de to-do list para la sesión."""
        # Si ya está abierta, traerla al frente
        if self._tasks_window and self._tasks_window.winfo_exists():
            self._tasks_window.lift()
            return

        win = tk.Toplevel(self.root)
        win.title("tareas de la sesión")
        win.configure(bg=BG)
        win.resizable(False, False)
        win.attributes("-topmost", True)
        sw, sh = win.winfo_screenwidth(), win.winfo_screenheight()
        win.geometry(f"280x360+{(sw-280)//2}+{(sh-360)//2}")
        self._tasks_window = win

        # ── Header ───────────────────────────────────────────────
        tk.Label(win, text="tareas de esta sesión",
                 bg=BG, fg=FG_DIM, font=FONT_SMALL).pack(pady=(10, 6))

        # ── Frame scrollable de tareas ───────────────────────────
        list_outer = tk.Frame(win, bg=BG)
        list_outer.pack(fill="both", expand=True, padx=10)

        vscroll = tk.Scrollbar(list_outer, orient="vertical", bg=BTN_BG,
                               troughcolor=BG, width=8)
        vscroll.pack(side="right", fill="y")

        list_canvas = tk.Canvas(list_outer, bg=BG, highlightthickness=0,
                                yscrollcommand=vscroll.set)
        list_canvas.pack(side="left", fill="both", expand=True)
        vscroll.config(command=list_canvas.yview)

        tasks_frame = tk.Frame(list_canvas, bg=BG)
        tasks_frame_id = list_canvas.create_window((0, 0), window=tasks_frame,
                                                    anchor="nw")

        def _update_scroll(e=None):
            list_canvas.config(scrollregion=list_canvas.bbox("all"))
            list_canvas.itemconfig(tasks_frame_id, width=list_canvas.winfo_width())
        tasks_frame.bind("<Configure>", _update_scroll)
        list_canvas.bind("<Configure>", _update_scroll)
        list_canvas.bind("<MouseWheel>",
            lambda e: list_canvas.yview_scroll(-1*(e.delta//120), "units"))

        task_widgets = []  # lista de (frame, var, text_lbl) para reordenar/borrar

        def _refresh_task_list():
            """Re-dibuja todos los widgets de tarea."""
            for w in tasks_frame.winfo_children():
                w.destroy()
            task_widgets.clear()
            for i, task in enumerate(self._session_tasks):
                _add_task_widget(i, task)
            _update_scroll()

        def _add_task_widget(idx, task):
            row = tk.Frame(tasks_frame, bg=BG)
            row.pack(fill="x", pady=1)

            # Checkbox
            cb = tk.Checkbutton(
                row, variable=task["done"],
                bg=BG, fg=ACCENT,
                activebackground=BG, activeforeground=ACCENT,
                selectcolor=BTN_BG,
                relief="flat", bd=0, cursor="hand2",
                command=lambda i=idx: _on_check(i)
            )
            cb.pack(side="left", padx=(2, 4))

            # Texto (tachable)
            def _make_lbl(i=idx):
                done = task["done"].get()
                comp_min = task.get("completion_min")
                text_display = task["text"]
                if done and comp_min is not None:
                    text_display = f"{task['text']}  (+{comp_min}min)"
                fg = "#555" if done else FG_TIME
                lbl = tk.Label(row, text=text_display,
                               bg=BG, fg=fg,
                               font=("Courier New", 9,
                                     "overstrike" if done else "normal"),
                               anchor="w", justify="left", wraplength=190)
                lbl.pack(side="left", fill="x", expand=True, padx=(0, 4))
                return lbl
            _make_lbl()
            # Botón notas
            note_btn = tk.Label(row, text="✎", bg=BG, fg="#555",
                    font=("Courier New", 9), cursor="hand2")
            note_btn.pack(side="right", padx=(0, 2))
            note_btn.bind("<Enter>", lambda e, b=note_btn: b.config(fg=ACCENT))
            note_btn.bind("<Leave>", lambda e, b=note_btn: b.config(fg="#555"))
            note_btn.bind("<Button-1>", lambda e, i=idx, b=note_btn: _open_notes(i, b))            # Botón eliminar
            del_btn = tk.Label(row, text="✕", bg=BG, fg="#333",
                               font=("Courier New", 8), cursor="hand2")
            del_btn.pack(side="right", padx=(0, 4))
            del_btn.bind("<Enter>", lambda e, b=del_btn: b.config(fg="#ff4444"))
            del_btn.bind("<Leave>", lambda e, b=del_btn: b.config(fg="#333"))
            del_btn.bind("<Button-1>", lambda e, i=idx: _delete_task(i))

            task_widgets.append((row,))

        def _on_check(idx):
            task = self._session_tasks[idx]
            if task["done"].get():
                # Acaba de ser marcada como completada
                elapsed_secs = self._total - self._remaining if self._total > 0 else 0
                elapsed_min  = elapsed_secs // 60
                task["completion_min"] = elapsed_min  # minuto de la sesión en que se completó

                # Sonido: ¿todas completadas?
                all_done = all(t["done"].get() for t in self._session_tasks)
                if all_done:
                    self._play_sound("all_done")
                else:
                    self._play_sound("task_done")
            else:
                # Desmarcada: limpiar tiempo
                task["completion_min"] = None

            _refresh_task_list()
            _update_tasks_btn()

        def _delete_task(idx):
            if 0 <= idx < len(self._session_tasks):
                self._session_tasks.pop(idx)
                _refresh_task_list()
            _update_tasks_btn()


        def _open_notes(idx, note_btn=None):
            task = self._session_tasks[idx]
            dlg = tk.Toplevel(win)
            dlg.title("")
            dlg.configure(bg=BG)
            dlg.resizable(False, False)
            dlg.attributes("-topmost", True)
            sw2, sh2 = dlg.winfo_screenwidth(), dlg.winfo_screenheight()
            dlg.geometry(f"260x180+{(sw2-260)//2}+{(sh2-180)//2}")

            tk.Label(dlg, text=task["text"], bg=BG, fg=ACCENT,
                    font=("Courier New", 9, "bold"), wraplength=240).pack(pady=(10, 4))
            tk.Label(dlg, text="notas", bg=BG, fg=FG_DIM,
                    font=FONT_SMALL).pack()

            txt = tk.Text(dlg, bg=BTN_BG, fg=FG_TIME, insertbackground=FG_TIME,
                        relief="flat", bd=0, font=("Courier New", 9),
                        width=30, height=5, wrap="word")
            txt.pack(padx=10, pady=4, fill="both", expand=True)
            txt.insert("1.0", task.get("notes", ""))
            txt.focus_set()

            def _save_notes():
                task["notes"] = txt.get("1.0", "end-1c").strip()
                # Actualizar color del botón si tiene notas
                note_btn.config(fg=ACCENT if task["notes"] else "#555")
                dlg.destroy()

            tk.Button(dlg, text="guardar", bg=ACCENT, fg="#000",
                    activebackground="#91a7ed", activeforeground="#000",
                    relief="flat", bd=0, font=("Courier New", 9, "bold"),
                    padx=10, pady=4, cursor="hand2",
                    command=_save_notes).pack(pady=(0, 8))
            dlg.bind("<Return>", lambda e: _save_notes())





        def _update_tasks_btn():
            """Actualiza el color del botón según si hay tareas."""
            total = len(self._session_tasks)
            done  = sum(1 for t in self._session_tasks if t["done"].get())
            if total == 0:
                self.tasks_btn.config(fg=FG_DIM)
            elif done == total:
                self.tasks_btn.config(fg=ACCENT)
            else:
                self.tasks_btn.config(fg="#ffcc00")

        # ── Input nueva tarea ────────────────────────────────────
        input_row = tk.Frame(win, bg=BG)
        input_row.pack(fill="x", padx=10, pady=(6, 2))

        task_var = tk.StringVar()
        task_entry = tk.Entry(input_row, textvariable=task_var,
                              bg=BTN_BG, fg=FG_TIME, insertbackground=FG_TIME,
                              relief="flat", bd=0, font=("Courier New", 9),
                              justify="left")
        task_entry.pack(side="left", fill="x", expand=True, ipady=4, padx=(0, 4))
        task_entry.focus_set()

        def _add_task(event=None):
            text = task_var.get().strip()
            if not text:
                return
            self._session_tasks.append({
                "text":           text,
                "done":           tk.BooleanVar(value=False),
                "completion_min": None,
                "notes":          "",
            })
            task_var.set("")
            _refresh_task_list()
            _update_tasks_btn()
            # scroll abajo
            list_canvas.update_idletasks()
            list_canvas.yview_moveto(1.0)

        task_entry.bind("<Return>", _add_task)

        add_btn = tk.Button(input_row, text="+ agregar",
                            bg=ACCENT, fg="#000",
                            activebackground="#91a7ed", activeforeground="#000",
                            relief="flat", bd=0, font=("Courier New", 9, "bold"),
                            padx=8, pady=3, cursor="hand2", command=_add_task)
        add_btn.pack(side="left")

        tk.Label(win, text="Enter para agregar  ·  ✕ para borrar",
                 bg=BG, fg="#333", font=("Courier New", 7)).pack(pady=(0, 6))

        # Cargar tareas existentes
        _refresh_task_list()

    # ════════════════════════════════════════════════════════════
    # LOG DE SESIÓN
    # ════════════════════════════════════════════════════════════
    def _show_log_dialog(self):
        """Cartel post-sesión para escribir qué hiciste + revisar tareas + nivel de energía."""
        now = self._start_at or datetime.now()
        dlg = tk.Toplevel(self.root)
        dlg.title("¿Qué hiciste en esta sesión?")
        dlg.configure(bg=BG)
        dlg.resizable(False, False)
        dlg.attributes("-topmost", True)

        has_tasks = bool(self._session_tasks)
        h = 520 if has_tasks else 360
        dlg.update_idletasks()
        sw, sh = dlg.winfo_screenwidth(), dlg.winfo_screenheight()
        dlg.geometry(f"400x{h}+{(sw-400)//2}+{(sh-h)//2}")

        tk.Label(dlg, text="sesión terminada  ·  anotá qué hiciste",
                 bg=BG, fg=FG_DIM, font=FONT_SMALL).pack(pady=(12, 4))

        txt = tk.Text(dlg, bg=BTN_BG, fg=FG_TIME, insertbackground=FG_TIME,
                      relief="flat", bd=0, font=("Courier New", 10),
                      wrap="word", width=42, height=5,
                      padx=8, pady=6)
        txt.pack(padx=12, fill="x")
        txt.focus_set()

        # ── Sección de tareas (si las hay) ───────────────────────
        if has_tasks:
            tk.Frame(dlg, bg="#222", height=1).pack(fill="x", padx=12, pady=(8, 0))
            tk.Label(dlg, text="tareas de la sesión  ·  marcá las que completaste",
                     bg=BG, fg=FG_DIM, font=FONT_SMALL).pack(pady=(6, 4))

            tasks_outer = tk.Frame(dlg, bg=BTN_BG, bd=0)
            tasks_outer.pack(fill="x", padx=12, pady=(0, 4))

            for task in self._session_tasks:
                t_row = tk.Frame(tasks_outer, bg=BTN_BG)
                t_row.pack(fill="x", pady=1)

                def _make_cb_lbl(t=task, rw=t_row):
                    cb = tk.Checkbutton(
                        rw, variable=t["done"],
                        bg=BTN_BG, fg=ACCENT,
                        activebackground=BTN_BG, activeforeground=ACCENT,
                        selectcolor=BG,
                        relief="flat", bd=0, cursor="hand2",
                        command=lambda tt=t, r=rw: _on_final_check(tt, r)
                    )
                    cb.pack(side="left", padx=(6, 2))
                    done = t["done"].get()
                    comp_min = t.get("completion_min")
                    display = t["text"]
                    if done and comp_min is not None:
                        display = f"{t['text']}  (+{comp_min}min)"
                    lbl = tk.Label(rw, text=display,
                                   bg=BTN_BG, fg="#555" if done else FG_TIME,
                                   font=("Courier New", 9,
                                         "overstrike" if done else "normal"),
                                   anchor="w", wraplength=300)
                    lbl.pack(side="left", fill="x", expand=True, padx=(0, 6))
                    return cb, lbl

                _make_cb_lbl()

            def _on_final_check(tt, rw):
                """Al tachar en ventana final: registrar tiempo al final de la sesión."""
                if tt["done"].get() and tt.get("completion_min") is None:
                    tt["completion_min"] = self._total // 60  # al final = duración total
                elif not tt["done"].get():
                    tt["completion_min"] = None
                # Refrescar label
                for w in rw.winfo_children():
                    if isinstance(w, tk.Label):
                        done = tt["done"].get()
                        comp_min = tt.get("completion_min")
                        display = tt["text"]
                        if done and comp_min is not None:
                            display = f"{tt['text']}  (+{comp_min}min)"
                        w.config(text=display,
                                 fg="#555" if done else FG_TIME,
                                 font=("Courier New", 9,
                                       "overstrike" if done else "normal"))
                # Sonido
                if tt["done"].get():
                    all_done = all(t["done"].get() for t in self._session_tasks)
                    self._play_sound("all_done" if all_done else "task_done")

        # ── Nivel de energía ─────────────────────────────────────
        tk.Frame(dlg, bg="#222", height=1).pack(fill="x", padx=12, pady=(8, 0))
        tk.Label(dlg, text="nivel de energía en la sesión",
                 bg=BG, fg=FG_DIM, font=FONT_SMALL).pack(pady=(6, 4))

        energy_var = tk.IntVar(value=5)

        energy_frame = tk.Frame(dlg, bg=BG)
        energy_frame.pack(padx=12, fill="x", pady=(0, 4))

        energy_btns = {}

        def _set_energy(val):
            energy_var.set(val)
            for v, b in energy_btns.items():
                ebg, efg = _energy_color(v)
                if v <= val:
                    b.config(bg=ebg, fg=efg)
                else:
                    b.config(bg=BTN_BG, fg="#444")

        for i in range(1, 11):
            ebg, efg = _energy_color(i)
            btn = tk.Label(energy_frame, text=str(i),
                           bg=ebg if i <= 5 else BTN_BG,
                           fg=efg if i <= 5 else "#444",
                           font=("Courier New", 9, "bold"),
                           width=3, pady=5, cursor="hand2", relief="flat")
            btn.pack(side="left", padx=1)
            btn.bind("<Button-1>", lambda e, v=i: _set_energy(v))
            btn.bind("<Enter>", lambda e, v=i, b=btn: b.config(
                bg=_energy_color(v)[0], fg=_energy_color(v)[1]))
            btn.bind("<Leave>", lambda e, v=i, b=btn: b.config(
                bg=_energy_color(v)[0] if v <= energy_var.get() else BTN_BG,
                fg=_energy_color(v)[1] if v <= energy_var.get() else "#444"))
            energy_btns[i] = btn

        ENERGY_LABELS_TEXT = {
            1: "agotado/a", 2: "muy bajo", 3: "bajo", 4: "algo cansado/a",
            5: "normal", 6: "bien", 7: "bastante bien", 8: "con energía",
            9: "muy activo/a", 10: "máxima energía ⚡"
        }

        energy_desc = tk.Label(dlg, text="", bg=BG, fg=FG_DIM, font=("Courier New", 8))
        energy_desc.pack()

        def _update_energy_desc(*args):
            v = energy_var.get()
            _, efg = _energy_color(v)
            energy_desc.config(
                text=f"{v} / 10  —  {ENERGY_LABELS_TEXT.get(v, '')}",
                fg=efg)
        energy_var.trace_add("write", _update_energy_desc)
        _update_energy_desc()

        # ─────────────────────────────────────────────────────────
        btn_row = tk.Frame(dlg, bg=BG)
        btn_row.pack(pady=10)

        def save_and_close():
            content = txt.get("1.0", "end").strip()
            energy  = energy_var.get()
            if content or has_tasks:
                self._save_session_log(now, content, energy=energy)
            dlg.destroy()
            self._show_setup()
            self._session_tasks = []
            try:
                if self.tasks_btn.winfo_exists():
                    self.tasks_btn.config(fg=FG_DIM)
            except Exception:
                pass

        def skip():
            dlg.destroy()
            self._show_setup()
            self._session_tasks = []
            try:
                if self.tasks_btn.winfo_exists():
                    self.tasks_btn.config(fg=FG_DIM)
            except Exception:
                pass

        save_btn = tk.Button(btn_row, text="guardar",
                             bg=ACCENT, fg="#000",
                             activebackground="#91a7ed", activeforeground="#000",
                             relief="flat", bd=0, font=("Courier New", 9, "bold"),
                             padx=12, pady=5, cursor="hand2", command=save_and_close)
        save_btn.pack(side="left", padx=6)

        skip_btn = tk.Button(btn_row, text="omitir",
                             bg=BTN_BG, fg=FG_DIM,
                             activebackground=BTN_HOVER, activeforeground=FG_TIME,
                             relief="flat", bd=0, font=FONT_SMALL,
                             padx=10, pady=5, cursor="hand2", command=skip)
        skip_btn.pack(side="left", padx=6)
        skip_btn.bind("<Enter>", lambda e: skip_btn.config(bg=BTN_HOVER, fg=FG_TIME))
        skip_btn.bind("<Leave>", lambda e: skip_btn.config(bg=BTN_BG, fg=FG_DIM))

        dlg.bind("<Control-Return>", lambda e: save_and_close())

    def _save_session_log(self, session_start, content, dur_min=None, energy=None):
        """Guarda el log en sesiones/YYYY-MM-DD/HH-MM.txt"""
        base   = _sessions_base()
        day    = session_start.strftime("%Y-%m-%d")
        time   = session_start.strftime("%H-%M")
        folder = os.path.join(base, day)
        os.makedirs(folder, exist_ok=True)
        filepath = os.path.join(folder, f"{time}.txt")
        if dur_min is None:
            dur_min = self._total // 60
        sep   = "─" * 40
        energy_str = f"  |  energía: {energy}/10" if energy is not None else ""
        header = (
            f"Sesión: {session_start.strftime('%d/%m/%Y  %H:%M')}  ({dur_min} min){energy_str}\n"
            f"{sep}\n\n"
        )

        # Sección de tareas con tiempos
        tasks_section = ""
        if self._session_tasks:
            done_tasks    = [t for t in self._session_tasks if t["done"].get()]
            pending_tasks = [t for t in self._session_tasks if not t["done"].get()]
            tasks_section += f"{sep}\n"
            tasks_section += "TAREAS COMPLETADAS:\n"
            if done_tasks:
                for t in done_tasks:
                    comp_min = t.get("completion_min")
                    if comp_min is not None:
                        tasks_section += f"  [x] {t['text']}  (+{comp_min} min desde inicio)\n"
            else:
                tasks_section += f"  [x] {t['text']}\n"
            if t.get("notes"):
                tasks_section += f"      → {t['notes']}\n"

            else:
                tasks_section += "  (ninguna)\n"
            tasks_section += "\nTAREAS PENDIENTES:\n"
            if pending_tasks:
                for t in pending_tasks:
                    tasks_section += f"  [ ] {t['text']}\n"
            if t.get("notes"):
                tasks_section += f"      → {t['notes']}\n"
            else:
                tasks_section += "  (ninguna)\n"
            tasks_section += "\n"

        notes_section = ""
        if content:
            notes_section = f"{sep}\nNOTAS:\n{content}\n"

        with open(filepath, "w", encoding="utf-8") as f:
            f.write(header + tasks_section + notes_section)

    def _show_manual_session_dialog(self, prefill_dt, prefill_dur, on_saved):
        """Formulario para agregar una sesión manual desde el calendario."""
        dlg = tk.Toplevel(self.root)
        dlg.title("Agregar sesión manual")
        dlg.configure(bg=BG)
        dlg.resizable(False, False)
        dlg.attributes("-topmost", True)
        sw, sh = dlg.winfo_screenwidth(), dlg.winfo_screenheight()
        dlg.geometry(f"360x420+{(sw-360)//2}+{(sh-420)//2}")

        tk.Label(dlg, text="sesión manual", bg=BG, fg=FG_DIM,
                 font=FONT_SMALL).pack(pady=(12,6))

        fields = tk.Frame(dlg, bg=BG)
        fields.pack(padx=16, fill="x")

        def field_row(label, default, width=10):
            row = tk.Frame(fields, bg=BG)
            row.pack(fill="x", pady=3)
            tk.Label(row, text=label, bg=BG, fg=FG_DIM,
                     font=FONT_SMALL, width=10, anchor="w").pack(side="left")
            var = tk.StringVar(value=default)
            e = tk.Entry(row, textvariable=var, width=width,
                         bg=BTN_BG, fg=FG_TIME, insertbackground=FG_TIME,
                         relief="flat", bd=0, font=("Courier New", 10),
                         justify="left")
            e.pack(side="left", ipady=3, padx=(4,0))
            return var

        date_var = field_row("fecha",    prefill_dt.strftime("%Y-%m-%d"), width=12)
        time_var = field_row("hora",     prefill_dt.strftime("%H:%M"),    width=8)
        dur_var  = field_row("duración", str(prefill_dur),                width=6)
        tk.Label(fields, text="             (minutos)", bg=BG, fg="#444",
                 font=("Courier New", 7)).pack(anchor="w")

        tk.Label(dlg, text="notas", bg=BG, fg=FG_DIM,
                 font=FONT_SMALL).pack(anchor="w", padx=16, pady=(8,2))

        txt = tk.Text(dlg, bg=BTN_BG, fg=FG_TIME, insertbackground=FG_TIME,
                      relief="flat", bd=0, font=("Courier New", 10),
                      wrap="word", width=38, height=7, padx=8, pady=6)
        txt.pack(padx=16, fill="x")
        txt.focus_set()

        err_lbl = tk.Label(dlg, text="", bg=BG, fg="#ff6666", font=FONT_SMALL)
        err_lbl.pack()

        btn_row = tk.Frame(dlg, bg=BG)
        btn_row.pack(pady=8)

        def save():
            try:
                from datetime import datetime as dt_cls
                d = dt_cls.strptime(date_var.get().strip(), "%Y-%m-%d")
                t = dt_cls.strptime(time_var.get().strip(), "%H:%M")
                session_dt = d.replace(hour=t.hour, minute=t.minute, second=0)
                dur = int(dur_var.get().strip())
                if dur <= 0:
                    raise ValueError("duración inválida")
            except Exception as ex:
                err_lbl.config(text=f"error: {ex}")
                return
            content = txt.get("1.0", "end").strip()
            if not content:
                content = "(sin notas)"
            self._save_session_log(session_dt, content, dur_min=dur)
            dlg.destroy()
            on_saved()

        save_btn = tk.Button(btn_row, text="guardar",
                             bg=ACCENT, fg="#000",
                             activebackground="#91a7ed", activeforeground="#000",
                             relief="flat", bd=0, font=("Courier New", 9, "bold"),
                             padx=12, pady=5, cursor="hand2", command=save)
        save_btn.pack(side="left", padx=6)
        dlg.bind("<Control-Return>", lambda e: save())

        cancel_b = tk.Button(btn_row, text="cancelar",
                             bg=BTN_BG, fg=FG_DIM,
                             activebackground=BTN_HOVER, activeforeground=FG_TIME,
                             relief="flat", bd=0, font=FONT_SMALL,
                             padx=10, pady=5, cursor="hand2", command=dlg.destroy)
        cancel_b.pack(side="left", padx=6)
        cancel_b.bind("<Enter>", lambda e: cancel_b.config(bg=BTN_HOVER, fg=FG_TIME))
        cancel_b.bind("<Leave>", lambda e: cancel_b.config(bg=BTN_BG, fg=FG_DIM))

    def _load_all_sessions(self):
        """Devuelve dict {date(y,m,d): [(hh,mm,filepath), ...]}"""
        from datetime import date as date_cls
        base = _sessions_base()
        result = {}
        if not os.path.exists(base):
            return result
        for day_folder in os.listdir(base):
            day_path = os.path.join(base, day_folder)
            if not os.path.isdir(day_path):
                continue
            try:
                dt = datetime.strptime(day_folder, "%Y-%m-%d").date()
            except Exception:
                continue
            sessions = []
            for fname in sorted(os.listdir(day_path)):
                if not fname.endswith(".txt"):
                    continue
                try:
                    hh, mm = int(fname[:2]), int(fname[3:5])
                    sessions.append((hh, mm, os.path.join(day_path, fname)))
                except Exception:
                    continue
            if sessions:
                result[dt] = sessions
        return result

    def _show_calendar(self):
        """Vista de calendario semanal con bloques de sesión."""
        from datetime import date as date_cls, timedelta as td
        import locale

        dlg = tk.Toplevel(self.root)
        dlg.title("Calendario de sesiones")
        dlg.configure(bg=BG)
        dlg.resizable(True, True)
        dlg.attributes("-topmost", True)
        sw, sh = dlg.winfo_screenwidth(), dlg.winfo_screenheight()
        W, H = min(900, sw - 60), min(680, sh - 80)
        dlg.geometry(f"{W}x{H}+{(sw-W)//2}+{(sh-H)//2}")

        # Estado de navegación
        today     = date_cls.today()
        state     = {"week_start": today - td(days=today.weekday())}  # lunes
        all_sess  = self._load_all_sessions()

        DAYS_ES   = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
        HOUR_START = 0    # hora mínima visible
        HOUR_END   = 24   # hora máxima visible
        PX_PER_MIN = 1.2  # píxeles por minuto

        # ── Layout principal ────────────────────────────────────
        top_bar = tk.Frame(dlg, bg=BG, height=36)
        top_bar.pack(fill="x", padx=10, pady=(8,0))
        top_bar.pack_propagate(False)

        prev_btn = tk.Button(top_bar, text="◀", bg=BTN_BG, fg=FG_DIM,
                             relief="flat", bd=0, font=FONT_SMALL,
                             padx=8, pady=3, cursor="hand2")
        prev_btn.pack(side="left", padx=(0,4))

        next_btn = tk.Button(top_bar, text="▶", bg=BTN_BG, fg=FG_DIM,
                             relief="flat", bd=0, font=FONT_SMALL,
                             padx=8, pady=3, cursor="hand2")
        next_btn.pack(side="left", padx=(0,8))

        week_lbl = tk.Label(top_bar, text="", bg=BG, fg=FG_TIME,
                            font=("Courier New", 10, "bold"))
        week_lbl.pack(side="left")

        today_btn = tk.Button(top_bar, text="hoy", bg=BTN_BG, fg=FG_DIM,
                              relief="flat", bd=0, font=FONT_SMALL,
                              padx=8, pady=3, cursor="hand2")
        today_btn.pack(side="right")

        add_btn = tk.Button(top_bar, text="+ agregar sesión", bg=ACCENT, fg="#000",
                            activebackground="#91a7ed", activeforeground="#000",
                            relief="flat", bd=0, font=("Courier New", 9, "bold"),
                            padx=10, pady=3, cursor="hand2")
        add_btn.pack(side="right", padx=(0,8))

        # ── Canvas con scroll vertical ───────────────────────────
        cal_outer = tk.Frame(dlg, bg=BG)
        cal_outer.pack(fill="both", expand=True, padx=6, pady=6)

        vscroll = tk.Scrollbar(cal_outer, orient="vertical")
        vscroll.pack(side="right", fill="y")

        cal_canvas = tk.Canvas(cal_outer, bg="#141414",
                               highlightthickness=0,
                               yscrollcommand=vscroll.set)
        cal_canvas.pack(side="left", fill="both", expand=True)
        vscroll.config(command=cal_canvas.yview)

        cal_canvas.bind("<MouseWheel>",
            lambda e: cal_canvas.yview_scroll(-1*(e.delta//120), "units"))

        # ── Función de renderizado ───────────────────────────────
        def render_week():
            cal_canvas.delete("all")
            ws   = state["week_start"]
            days = [ws + td(days=i) for i in range(7)]

            # Actualizar label de semana
            week_lbl.config(text=f"{days[0].strftime('%d/%m')} – {days[6].strftime('%d/%m/%Y')}")

            cw = cal_canvas.winfo_width() or W - 30
            TIME_COL  = 42   # ancho columna horas
            DAY_W     = max(80, (cw - TIME_COL) // 7)
            total_h   = int((HOUR_END - HOUR_START) * 60 * PX_PER_MIN) + 30
            cal_canvas.config(scrollregion=(0, 0, TIME_COL + DAY_W*7, total_h))

            def y_of(hour, minute=0):
                return int(((hour - HOUR_START) * 60 + minute) * PX_PER_MIN) + 20

            # Líneas de hora
            for h in range(HOUR_START, HOUR_END + 1):
                y = y_of(h)
                cal_canvas.create_line(TIME_COL, y, TIME_COL + DAY_W*7, y,
                                       fill="#252525", width=1)
                cal_canvas.create_line(TIME_COL, y + int(15*PX_PER_MIN),
                                       TIME_COL + DAY_W*7, y + int(15*PX_PER_MIN),
                                       fill="#1e1e1e", width=1, dash=(2,4))
                cal_canvas.create_line(TIME_COL, y + int(30*PX_PER_MIN),
                                       TIME_COL + DAY_W*7, y + int(30*PX_PER_MIN),
                                       fill="#1e1e1e", width=1, dash=(2,4))
                cal_canvas.create_line(TIME_COL, y + int(45*PX_PER_MIN),
                                       TIME_COL + DAY_W*7, y + int(45*PX_PER_MIN),
                                       fill="#1e1e1e", width=1, dash=(2,4))
                label = f"{h}:00" if h < 24 else ""
                cal_canvas.create_text(TIME_COL - 4, y, text=label,
                                       anchor="e", fill="#444",
                                       font=("Courier New", 7))

            # Cabeceras de día
            for i, d in enumerate(days):
                x = TIME_COL + i * DAY_W + DAY_W // 2
                is_today = (d == today)
                name = DAYS_ES[d.weekday()]
                num  = str(d.day)
                fg_h = ACCENT if is_today else FG_DIM
                cal_canvas.create_text(x, 6, text=f"{name} {num}",
                                       anchor="n", fill=fg_h,
                                       font=("Courier New", 8,
                                             "bold" if is_today else "normal"))
                # línea vertical
                xv = TIME_COL + i * DAY_W
                cal_canvas.create_line(xv, 0, xv, total_h,
                                       fill="#252525", width=1)

            # Línea de hora actual (solo si la semana incluye hoy)
            if ws <= today <= days[-1]:
                now = datetime.now()
                y_now = y_of(now.hour, now.minute)
                today_idx = today.weekday()
                x0 = TIME_COL + today_idx * DAY_W
                cal_canvas.create_line(x0, y_now, x0 + DAY_W, y_now,
                                       fill=ACCENT, width=2)

            # Fallback colors (sin energía registrada)
            BLOCK_COLORS_FB = ["#1a3a1a", "#1a2a3a", "#2a1a3a", "#3a2a1a",
                               "#3a1a1a", "#1a3a3a", "#2a3a1a"]
            BLOCK_FG_FB     = ["#88ff88", "#88ccff", "#cc88ff", "#ffcc88",
                               "#ff8888", "#88ffff", "#ccff88"]

            for i, d in enumerate(days):
                sessions = all_sess.get(d, [])
                x1 = TIME_COL + i * DAY_W + 3
                x2 = TIME_COL + (i+1) * DAY_W - 3
                for si, (hh, mm, fpath) in enumerate(sessions):
                    # Leer duración y energía del header
                    dur    = 75   # default
                    energy = None
                    try:
                        with open(fpath, encoding="utf-8") as f:
                            first = f.readline()
                        import re
                        m_dur = re.search(r"\((\d+) min\)", first)
                        if m_dur:
                            dur = int(m_dur.group(1))
                        m_en = re.search(r"energía:\s*(\d+)/10", first)
                        if m_en:
                            energy = int(m_en.group(1))
                    except Exception:
                        pass

                    y1 = y_of(hh, mm)
                    y2 = y_of(hh, mm + dur)

                    # Color: si hay energía usar paleta, si no fallback rotativo
                    if energy is not None:
                        bg_blk, fg_blk = _energy_color(energy)
                        outline_col = fg_blk
                    else:
                        ci = si % len(BLOCK_COLORS_FB)
                        bg_blk = BLOCK_COLORS_FB[ci]
                        fg_blk = BLOCK_FG_FB[ci]
                        outline_col = "#333"

                    rect = cal_canvas.create_rectangle(
                        x1, y1, x2, y2,
                        fill=bg_blk, outline=outline_col, width=1)

                    # Etiqueta hora + nivel de energía si disponible
                    label_txt = f"{hh}:{mm:02d}"
                    if energy is not None:
                        label_txt += f"  ⚡{energy}"
                    lbl = cal_canvas.create_text(
                        x1 + 5, y1 + 6,
                        text=label_txt, anchor="nw",
                        fill=fg_blk, font=("Courier New", 8, "bold"))

                    # Preview: primero tareas completadas, luego notas
                    try:
                        with open(fpath, encoding="utf-8") as f:
                            lines = f.readlines()
                        block_h = y2 - y1

                        # Buscar tareas completadas
                        done_tasks = [l.strip()[4:] for l in lines if l.strip().startswith("[x]")]
                        pending_tasks = [l.strip()[4:] for l in lines if l.strip().startswith("[ ]")]

                        if done_tasks or pending_tasks:
                            preview_parts = []
                            if done_tasks:
                                preview_parts.append(f"✓{len(done_tasks)}")
                            if pending_tasks:
                                preview_parts.append(f"○{len(pending_tasks)}")
                            tasks_summary = " ".join(preview_parts)
                            # Mostrar primera tarea completada o pendiente como texto
                            first_task = (done_tasks or pending_tasks)[0]
                            if len(first_task) > 16:
                                first_task = first_task[:16] + "…"
                            preview = f"{tasks_summary} {first_task}"
                        else:
                            # Fallback: primera línea de notas
                            preview = next((l.strip() for l in lines[3:]
                                            if l.strip() and not set(l.strip()) <= set("─")
                                            and not l.strip().endswith(":")
                                            and not l.strip().startswith("[")
                                            and l.strip() != "(ninguna)"), "")

                        if preview and block_h > 28:
                            if len(preview) > 22:
                                preview = preview[:22] + "…"
                            cal_canvas.create_text(
                                x1 + 5, y1 + 18,
                                text=preview, anchor="nw",
                                fill=fg_blk,
                                font=("Courier New", 7))
                    except Exception:
                        pass

                    # Click en bloque
                    def on_click(event, fp=fpath):
                        self._show_session_detail(fp)
                    cal_canvas.tag_bind(rect, "<Button-1>", on_click)
                    cal_canvas.tag_bind(lbl,  "<Button-1>", on_click)
                    cal_canvas.tag_bind(rect, "<Enter>",
                        lambda e, r=rect: cal_canvas.itemconfig(r, outline=ACCENT, width=2))
                    cal_canvas.tag_bind(rect, "<Leave>",
                        lambda e, r=rect: cal_canvas.itemconfig(r, outline=outline_col, width=1))

            # Scroll automático a hora laboral al abrir
            cal_canvas.yview_moveto(max(0, y_of(6) / total_h - 0.05))

        # ── Navegación ───────────────────────────────────────────
        def go_prev():
            state["week_start"] -= td(weeks=1)
            dlg.after(10, render_week)

        def go_next():
            state["week_start"] += td(weeks=1)
            dlg.after(10, render_week)

        def go_today():
            state["week_start"] = today - td(days=today.weekday())
            dlg.after(10, render_week)

        def open_add():
            from datetime import date as date_cls
            prefill_dt = datetime.combine(today, __import__("datetime").time(9, 0))
            prefill_dur = (self._total // 60) if self._total > 0 else 75
            def on_saved():
                nonlocal all_sess
                all_sess = self._load_all_sessions()
                render_week()
            self._show_manual_session_dialog(prefill_dt, prefill_dur, on_saved)

        prev_btn.config(command=go_prev)
        next_btn.config(command=go_next)
        today_btn.config(command=go_today)
        add_btn.config(command=open_add)
        add_btn.bind("<Enter>", lambda e: add_btn.config(bg="#91a7ed"))
        add_btn.bind("<Leave>", lambda e: add_btn.config(bg=ACCENT))

        for btn in [prev_btn, next_btn, today_btn]:
            btn.bind("<Enter>", lambda e, b=btn: b.config(bg=BTN_HOVER, fg=FG_TIME))
            btn.bind("<Leave>", lambda e, b=btn: b.config(bg=BTN_BG, fg=FG_DIM))

        # Re-renderizar al cambiar tamaño
        dlg.bind("<Configure>", lambda e: dlg.after(50, render_week))
        dlg.after(100, render_week)

    def _show_session_detail(self, filepath):
        """Muestra el contenido completo de una sesión con secciones formateadas."""
        dlg = tk.Toplevel(self.root)
        dlg.configure(bg=BG)
        dlg.resizable(True, True)
        dlg.attributes("-topmost", True)
        sw, sh = dlg.winfo_screenwidth(), dlg.winfo_screenheight()
        dlg.geometry(f"400x440+{(sw-400)//2}+{(sh-440)//2}")

        try:
            with open(filepath, encoding="utf-8") as f:
                content = f.read()
        except Exception:
            content = "Error leyendo el archivo."

        first_line = content.splitlines()[0] if content else filepath
        dlg.title(first_line[:50])

        # ── Texto con colores por sección ────────────────────────
        txt = tk.Text(dlg, bg=BTN_BG, fg=FG_TIME,
                      relief="flat", bd=0, font=("Courier New", 10),
                      wrap="word", padx=10, pady=8)
        txt.pack(fill="both", expand=True, padx=10, pady=(10, 0))

        # Tags de color
        txt.tag_config("header",    foreground=ACCENT, font=("Courier New", 10, "bold"))
        txt.tag_config("sep",       foreground="#333")
        txt.tag_config("section",   foreground="#ffcc00", font=("Courier New", 9, "bold"))
        txt.tag_config("done",      foreground="#91a7ed",
                                    font=("Courier New", 10, "overstrike"))
        txt.tag_config("pending",   foreground="#ff8888")
        txt.tag_config("notes",     foreground=FG_TIME)
        txt.tag_config("dim",       foreground=FG_DIM)
        txt.tag_config("time_hint", foreground="#888888", font=("Courier New", 9))

        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("Sesión:"):
                txt.insert("end", line + "\n", "header")
            elif set(stripped) <= set("─") and stripped:
                txt.insert("end", line + "\n", "sep")
            elif stripped in ("TAREAS COMPLETADAS:", "TAREAS PENDIENTES:", "NOTAS:"):
                txt.insert("end", line + "\n", "section")
            elif stripped.startswith("[x]"):
                # Separar nombre de tarea del tiempo
                txt.insert("end", line + "\n", "done")
            elif stripped.startswith("[ ]"):
                txt.insert("end", line + "\n", "pending")
            elif stripped == "(ninguna)":
                txt.insert("end", line + "\n", "dim")
            elif stripped.startswith("(+") and "min" in stripped:
                txt.insert("end", line + "\n", "time_hint")
            else:
                txt.insert("end", line + "\n", "notes")

        txt.config(state="disabled")

        tk.Button(dlg, text="cerrar",
                  bg=BTN_BG, fg=FG_DIM,
                  activebackground=BTN_HOVER, activeforeground=FG_TIME,
                  relief="flat", bd=0, font=FONT_SMALL,
                  padx=10, pady=5, cursor="hand2",
                  command=dlg.destroy).pack(pady=8)

    # ════════════════════════════════════════════════════════════
    # DRAG / POSICIÓN
    # ════════════════════════════════════════════════════════════
    # ════════════════════════════════════════════════════════════
    # AUTO-UPDATER
    # ════════════════════════════════════════════════════════════
    def _bg_check_update(self):
        """Chequea actualizaciones en un hilo de fondo, sin bloquear la UI."""
        def _check():
            version, url = _check_update_available()
            if version:
                self.root.after(0, lambda: self._show_update_available(version, url))
        threading.Thread(target=_check, daemon=True).start()

    def _show_update_available(self, version, url):
        """Muestra el botón de actualización en la UI."""
        self._pending_update_url = url
        try:
            self._upd_btn.config(
                text=f"↑ actualizar a v{version}",
                fg=ACCENT,
            )
            self._upd_btn.bind("<Enter>", lambda e: self._upd_btn.config(fg="#ffffff"))
            self._upd_btn.bind("<Leave>", lambda e: self._upd_btn.config(fg=ACCENT))
        except Exception:
            pass

    def _run_update(self):
        """Descarga y prepara la actualización con barra de progreso."""
        url = getattr(self, "_pending_update_url", None)
        if not url:
            return

        # Ventana de progreso
        dlg = tk.Toplevel(self.root)
        dlg.configure(bg=BG)
        dlg.resizable(False, False)
        dlg.attributes("-topmost", True)
        dlg.overrideredirect(True)
        sw, sh = dlg.winfo_screenwidth(), dlg.winfo_screenheight()
        dlg.geometry(f"260x90+{(sw-260)//2}+{(sh-90)//2}")

        tk.Label(dlg, text="descargando actualización...",
                 bg=BG, fg=FG_DIM, font=FONT_SMALL).pack(pady=(14, 4))

        prog_outer = tk.Frame(dlg, bg=BTN_BG, height=6, width=220)
        prog_outer.pack(pady=4)
        prog_outer.pack_propagate(False)
        prog_bar = tk.Frame(prog_outer, bg=ACCENT, height=6, width=0)
        prog_bar.place(x=0, y=0, height=6, width=0)

        status_lbl = tk.Label(dlg, text="0%", bg=BG, fg=FG_DIM, font=FONT_SMALL)
        status_lbl.pack()

        def _on_progress(pct):
            w = int(220 * pct / 100)
            prog_bar.place(width=w)
            status_lbl.config(text=f"{pct}%")
            dlg.update_idletasks()

        def _on_done(bat_path):
            dlg.destroy()
            if bat_path:
                msg = tk.Toplevel(self.root)
                msg.configure(bg=BG)
                msg.resizable(False, False)
                msg.attributes("-topmost", True)
                msg.overrideredirect(True)
                sw2, sh2 = msg.winfo_screenwidth(), msg.winfo_screenheight()
                msg.geometry(f"280x100+{(sw2-280)//2}+{(sh2-100)//2}")
                tk.Label(msg, text="✓ descarga completa",
                         bg=BG, fg=ACCENT, font=FONT_SMALL).pack(pady=(16, 4))
                tk.Label(msg, text="cerrar la app para aplicar la actualización",
                         bg=BG, fg=FG_DIM, font=FONT_SMALL).pack()

                def _apply_and_quit():
                    try:
                        subprocess.Popen(bat_path, shell=True,
                                         creationflags=subprocess.CREATE_NO_WINDOW)
                    except Exception:
                        pass
                    self._cleanup_and_quit()

                tk.Button(msg, text="cerrar y actualizar",
                          bg=ACCENT, fg="#000",
                          activebackground="#91a7ed", activeforeground="#000",
                          relief="flat", bd=0, font=("Courier New", 9, "bold"),
                          padx=10, pady=5, cursor="hand2",
                          command=_apply_and_quit).pack(pady=(8, 0))
            else:
                self._upd_btn.config(text="✓ descargado (modo dev)", fg=FG_DIM)

        def _on_error(err):
            dlg.destroy()
            self._upd_btn.config(text=f"error: {err[:30]}", fg=FG_WARN)

        threading.Thread(
            target=_download_and_replace,
            args=(url,),
            kwargs={"on_progress": lambda p: self.root.after(0, lambda p=p: _on_progress(p)),
                    "on_done":     lambda b: self.root.after(0, lambda b=b: _on_done(b)),
                    "on_error":    lambda e: self.root.after(0, lambda e=e: _on_error(e))},
            daemon=True,
        ).start()

    def _drag_start(self, e):
        self._drag_x = e.x_root - self.root.winfo_x()
        self._drag_y = e.y_root - self.root.winfo_y()

    def _drag_move(self, e):
        self.root.geometry(f"+{e.x_root - self._drag_x}+{e.y_root - self._drag_y}")

    def _center_window(self):
        self.root.update_idletasks()
        sw = self.root.winfo_screenwidth()
        w  = self.root.winfo_width()
        self.root.geometry(f"+{sw - w - 30}+40")

    def _cleanup_and_quit(self):
        if self._icon_tmp and os.path.exists(self._icon_tmp):
            try: os.unlink(self._icon_tmp)
            except: pass
        try:
            self.taskbar_root.destroy()
        except Exception:
            self.root.destroy()


# ════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    try:
        # Ventana madre: aparece en taskbar pero es invisible
        root = tk.Tk()
        root.title("Just Timer")
        root.geometry("1x1+0+0")
        root.configure(bg=BG)
        root.resizable(False, False)
        # Cargar icono en la ventana madre (es la que aparece en taskbar)
        try:
            ico_path = os.path.join(
                os.path.dirname(sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__)),
                "logo.ico"
            )
            root.iconbitmap(ico_path)
        except Exception:
            pass

        tmp = None

        # Ventana hija flotante: la UI real
        win = tk.Toplevel(root)
        app = JustTimer(win, taskbar_root=root)

        def on_close():
            if tmp:
                try: os.unlink(tmp.name)
                except: pass
            root.destroy()

        root.protocol("WM_DELETE_WINDOW", on_close)
        win.protocol("WM_DELETE_WINDOW", on_close)

        root.mainloop()
    except Exception:
        import tkinter.messagebox as mb
        try:
            mb.showerror("Error - Focus Timer", traceback.format_exc())
        except:
            print(traceback.format_exc(), file=sys.stderr)