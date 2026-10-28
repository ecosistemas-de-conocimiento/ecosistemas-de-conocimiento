"""
The spreadsheet the V3 participante uploads (C1.7) and asks about (B1.10).

    python3 apps/web/e2e/evidencia/hoja.py <salida.xlsx>

`correr.sh` runs it ON THE HOST before every run (openpyxl 3.1.5 there, checked
2026-10-28; the Playwright image has no openpyxl) and writes to the gitignored
`.videos/_hoja/casos-dengue.xlsx`, as it does for the WAV.

🔴 Invented numbers, invented colonias, no people. A participant's upload goes
through the anonymisation gate (backend `lib/autoPublish.ts`
`anonymiseParticipantUpload`) and auto-publishes once it clears, until the run's
cleanup deletes it: nothing in it may identify anyone.

The question the spec asks has one plain answer in the data: La Esperanza had
the most confirmed cases in September (23).

⚠ Built fresh each run: openpyxl stamps the creation time in docProps, so no
two runs upload the same bytes.
"""

import sys

from openpyxl import Workbook

COLONIAS = {
    # colonia: confirmed cases in julio, agosto, septiembre 2026 (invented)
    "Las Palmas": (4, 9, 12),
    "El Mirador": (2, 5, 7),
    "San Isidro": (6, 11, 15),
    "La Esperanza": (8, 17, 23),
}
MESES = ("julio", "agosto", "septiembre")


def main(salida: str) -> None:
    wb = Workbook()
    casos = wb.active
    casos.title = "Casos por colonia"
    casos.append(["Colonia", "Mes", "Año", "Casos confirmados", "Casos probables"])
    for colonia, confirmados in COLONIAS.items():
        for mes, n in zip(MESES, confirmados):
            # Probables: invented too, about half the confirmed count.
            casos.append([colonia, mes, 2026, n, max(1, n // 2)])

    notas = wb.create_sheet("Notas")
    notas.append(["Datos inventados para un video de demostración."])
    notas.append(["No corresponden a ningún registro de salud."])

    wb.properties.creator = "evidencia"
    wb.save(salida)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("uso: hoja.py <salida.xlsx>")
    main(sys.argv[1])
