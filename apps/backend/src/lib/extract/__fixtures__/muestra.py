# Writes muestra.xls (xlwt 1.3.0) and muestra.xlsx (openpyxl 3.1.5): the SAME workbook,
# so xls.test.ts can check both extract to the same text.
# Run: python3 -m venv v && v/bin/pip install xlwt==1.3.0 openpyxl==3.1.5 && v/bin/python muestra.py muestra
import datetime, sys, xlwt, openpyxl
out = sys.argv[1]
head = ['Comunidad', 'Municipio', 'Participantes', 'Fecha de visita', 'Acceso a agua']
rows = [
  ['San Andrés Cohamiata', 'Mezquitic', 42, datetime.date(2026, 3, 14), True],
  ['Santa Catarina Cuexcomatitlán', 'Mezquitic', 17.5, datetime.date(2026, 4, 2), False],
  ['Tuxpan de Bolaños', 'Bolaños', -3, datetime.date(1999, 12, 31), True],
  ['Ocota de la Sierra', 'Mezquitic', 123456789.25, datetime.date(2026, 10, 28), False],
]
notas = [(1, 1, 'La comunidad pidió un traductor wixárika — «ñandú» €'), (1, 2, 'segunda celda'), (3, 0, 'tras una fila vacía')]
largo = ('Relato largo con € y ñ. ' * 200).strip()
registros = [[f'Registro {i}', f'Responsable número {i} — José Ñúñez', i * 3] for i in range(1, 101)]

wb = xlwt.Workbook(encoding='utf-8')
datefmt = xlwt.easyxf(num_format_str='YYYY-MM-DD')
s = wb.add_sheet('Comunidades')
for c, v in enumerate(head): s.write(0, c, v)
for r, row in enumerate(rows, 1):
  for c, v in enumerate(row): s.write(r, c, v, datefmt) if isinstance(v, datetime.date) else s.write(r, c, v)
s = wb.add_sheet('Notas')
for r, c, v in notas: s.write(r, c, v)
s.write(5, 0, largo); s.write(6, 0, 'después del relato largo')
s = wb.add_sheet('Registros')
for r, row in enumerate(registros):
  for c, v in enumerate(row): s.write(r, c, v)
wb.add_sheet('Vacía')
wb.save(out + '.xls')

wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Comunidades'
ws.append(head)
for row in rows: ws.append(row)
for r in range(2, 2 + len(rows)): ws.cell(r, 4).number_format = 'yyyy-mm-dd'
ws = wb.create_sheet('Notas')
for r, c, v in notas: ws.cell(r + 1, c + 1, v)
ws.cell(6, 1, largo); ws.cell(7, 1, 'después del relato largo')
ws = wb.create_sheet('Registros')
for row in registros: ws.append(row)
wb.create_sheet('Vacía')
wb.save(out + '.xlsx')
