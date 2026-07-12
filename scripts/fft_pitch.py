#!/usr/bin/env python3
"""Egy hangfájl domináns frekvenciájának meghatározása FFT-vel.

A Codie csipogójáról készült felvétel (telefon) frekvenciájának méréséhez.
Bármilyen formátumot elfogad (ffmpeg-gel mono WAV-ra konvertál), megkeresi a
leghangosabb szakaszt (a beepet), és FFT-vel kiadja a domináns frekvenciát,
a felharmonikusokat és egy óvatos értelmezést (rezonáns buzzer vs passzív elem).

Használat:
    python scripts/fft_pitch.py <hangfajl> [--full]
    --full : a teljes fájlt elemzi, ne csak a leghangosabb szakaszt
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

MIN_FREQ = 150.0  # ez alatt (DC, hálózati brum) nem keresünk csúcsot


def load_mono(path: Path, target_sr: int = 44100) -> tuple[np.ndarray, int]:
    """Bármilyen hangfájl -> (mono float minták, mintavétel). ffmpeg-gel konvertál."""
    tmp = Path(tempfile.gettempdir()) / "codie_fft_input.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(path), "-ac", "1", "-ar", str(target_sr), "-f", "wav", str(tmp)],
        check=True, capture_output=True,
    )
    with wave.open(str(tmp), "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
        sampwidth = w.getsampwidth()
    dtype = {1: np.int8, 2: np.int16, 4: np.int32}[sampwidth]
    data = np.frombuffer(raw, dtype=dtype).astype(np.float64)
    if data.size:
        data /= np.abs(data).max() or 1.0
    return data, sr


def loudest_segment(x: np.ndarray, sr: int) -> np.ndarray:
    """A leghangosabb összefüggő szakasz (a beep) kivágása amplitúdó-burkolóból."""
    win = max(1, int(sr * 0.005))
    env = np.convolve(np.abs(x), np.ones(win) / win, mode="same")
    if env.max() <= 0:
        return x
    idx = np.where(env > 0.3 * env.max())[0]
    if idx.size > sr * 0.02:  # legalább 20 ms
        return x[idx[0]: idx[-1] + 1]
    return x


def refine_peak(mag: np.ndarray, freqs: np.ndarray, i: int) -> float:
    """Parabolikus interpoláció a csúcs körül (bin alatti pontosság)."""
    if 0 < i < len(mag) - 1:
        a, b, c = mag[i - 1], mag[i], mag[i + 1]
        denom = a - 2 * b + c
        delta = 0.5 * (a - c) / denom if denom != 0 else 0.0
    else:
        delta = 0.0
    return float(freqs[i] + delta * (freqs[1] - freqs[0]))


def analyze(x: np.ndarray, sr: int) -> None:
    n = len(x)
    if n < 64:
        print("Túl rövid a jel az elemzéshez.")
        return
    windowed = x * np.hanning(n)
    mag = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)

    mag[freqs < MIN_FREQ] = 0.0
    if mag.max() <= 0:
        print("Nem található érdemi csúcs a hangban.")
        return

    dom_i = int(np.argmax(mag))
    dom_f = refine_peak(mag, freqs, dom_i)
    print(f"\n>>> Domináns frekvencia: {dom_f:.1f} Hz  (~{_note(dom_f)})")

    # lokális maximumok (csúcsok), a legerősebb 6
    peaks = [
        i for i in range(1, len(mag) - 1)
        if mag[i] > mag[i - 1] and mag[i] > mag[i + 1] and freqs[i] >= MIN_FREQ
    ]
    peaks.sort(key=lambda i: mag[i], reverse=True)
    top = peaks[:6]
    ref = mag[dom_i]
    print("\nLegerősebb csúcsok:")
    for i in top:
        f = refine_peak(mag, freqs, i)
        db = 20 * np.log10(mag[i] / ref)
        ratio = f / dom_f
        harm = f"  (~{round(ratio)}. felharmonikus)" if abs(ratio - round(ratio)) < 0.06 and round(ratio) >= 2 else ""
        print(f"  {f:8.1f} Hz   {db:6.1f} dB{harm}")

    # felharmonikus-tartalom értékelése
    strong_harmonics = sum(
        1 for i in top
        if (r := refine_peak(mag, freqs, i) / dom_f) >= 1.5
        and abs(r - round(r)) < 0.06
        and 20 * np.log10(mag[i] / ref) > -20
    )
    print("\nÉrtelmezés (óvatosan):")
    if strong_harmonics >= 2:
        print(f"  Sok erős felharmonikus ({strong_harmonics}) -> négyszögjel-szerű meghajtás,")
        print("  inkább PASSZÍV piezo/hangszóró MCU-timerről (elvben variálható hangmagasság).")
    else:
        print("  Kevés felharmonikus, tiszta domináns csúcs -> inkább egy rezonanciára hangolt,")
        print("  önrezgő BUZZER (a hangmagasság valószínűleg hardveresen fix).")
    print("  Megjegyzés: ez heurisztika; a biztos válasz a fizikai alkatrész megnézése.")


def _note(f: float) -> str:
    if f <= 0:
        return "?"
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    midi = int(round(69 + 12 * np.log2(f / 440.0)))
    return f"{names[midi % 12]}{midi // 12 - 1}"


def main() -> None:
    args = [a for a in sys.argv[1:]]
    if not args:
        print(__doc__)
        return
    full = "--full" in args
    files = [a for a in args if not a.startswith("--")]
    if not files:
        print("Adj meg egy hangfájlt.")
        return
    path = Path(files[0])
    if not path.exists():
        print(f"Nincs ilyen fájl: {path}")
        return

    x, sr = load_mono(path)
    dur = len(x) / sr
    print(f"Fájl: {path.name}   |   {sr} Hz   |   {dur:.2f} s")
    seg = x if full else loudest_segment(x, sr)
    if not full:
        print(f"Elemzett (leghangosabb) szakasz: {len(seg) / sr:.2f} s")
    analyze(seg, sr)


if __name__ == "__main__":
    main()
