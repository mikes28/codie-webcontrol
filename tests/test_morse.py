"""Unit tesztek a Morse-ritmus kódolóra — robot nélkül futtatható."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from codie import morse, tunes  # noqa: E402


class MorseTest(unittest.TestCase):
    def test_single_e_is_one_dot(self):
        # 'E' = "." -> egyetlen rövid csipogás, záró szünet 0
        self.assertEqual(morse.text_to_rhythm("E", unit_ms=100), [(100, 0)])

    def test_t_is_one_dash(self):
        # 'T' = "-" -> 3 egység hang
        self.assertEqual(morse.text_to_rhythm("T", unit_ms=100), [(300, 0)])

    def test_sos_pattern(self):
        # S=... O=--- S=...  betűk közt 3 egység szünet
        pat = morse.text_to_rhythm("SOS", unit_ms=100)
        beeps = [b for b, _ in pat]
        self.assertEqual(beeps, [100, 100, 100, 300, 300, 300, 100, 100, 100])
        # betűhatárok: az S 3. jele után 3 egység (300) szünet
        self.assertEqual(pat[2][1], 300)
        self.assertEqual(pat[5][1], 300)
        # legutolsó jel után nincs szünet
        self.assertEqual(pat[-1][1], 0)

    def test_intra_char_gap_is_one_unit(self):
        # 'A' = ".-" : a pont után 1 egység szünet, a végén 0
        self.assertEqual(morse.text_to_rhythm("A", unit_ms=100), [(100, 100), (300, 0)])

    def test_word_gap_is_seven_units(self):
        # "E E" : E, majd 7 egység szünet, majd E
        pat = morse.text_to_rhythm("E E", unit_ms=100)
        self.assertEqual(pat, [(100, 700), (100, 0)])

    def test_unknown_chars_ignored(self):
        self.assertEqual(morse.text_to_rhythm("~E~", unit_ms=100), [(100, 0)])


class TunesTest(unittest.TestCase):
    def test_all_tunes_wellformed(self):
        self.assertIn("shave_haircut", tunes.RHYTHMS)
        for name, pattern in tunes.RHYTHMS.items():
            self.assertTrue(pattern, f"{name} üres")
            for beep, gap in pattern:
                self.assertGreater(beep, 0, f"{name}: nem pozitív csipogás")
                self.assertGreaterEqual(gap, 0, f"{name}: negatív szünet")


if __name__ == "__main__":
    unittest.main()
