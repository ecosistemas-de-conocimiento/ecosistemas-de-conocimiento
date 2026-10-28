"""Score OLD vs NEW prompt runs: per class, how many terms survive (kept) in redactedText.

A term counts as kept in a run when every occurrence in the input is still present
in the output (count_out >= count_in). Private terms must NOT be kept.

    python3 score.py <round dir with <text>-<prompt label>.jsonl> [inputs dir, default ./inputs]

The `kept` column reads "run1/run2 of N". `wrong` lists the terms that went the
wrong way in any run. ⚠ A held run (`hold:*`) is not published, so its kept
private terms are not a leak; read the RUN row's `result` beside it.
"""
import glob, json, os, sys

OUT = sys.argv[1]
INPUTS = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'inputs')

KEEP = 'keep'   # should survive
REDACT = 'redact'  # must be redacted

TERMS = {
    'q24-public': {
        ('public names', KEEP): ['PILARES', 'Lengua de Señas Mexicana', 'INDISCAPACIDAD CDMX', 'SECIHTI',
                                 'Ecosistemas de conocimiento y aprendizaje situado',
                                 'Centro de Investigación y Docencia Económicas', 'CIDE',
                                 'Foro de Saberes Comunitarios', 'UNAM', 'DIF'],
        ('team', KEEP): ['equipo del Ecosistema'],
        ('persons', REDACT): ['Mariela', 'Ocampo', 'Trejo', 'Herminia', 'Salas', 'Brandon'],
        ('addresses', REDACT): ['Fresno 18', 'El Arenal'],
        ('contact', REDACT): ['4321 8765'],
        ('workplace->1 person', REDACT): ['San Gregorio'],
    },
    'q24-classes': {
        ('concepts/words', KEEP): ['mito', 'ironía', 'fetichismo', 'empatía', 'marxismo', 'argentino'],
        ('works/quotes', KEEP): ['Gramática del relato', 'La injusticia del oído', 'Umbral', 'El Faro del Sur',
                                 'primera frontera'],
        ('public names/media', KEEP): ['QAnon', 'Radio Nopal', 'Charla Social'],
        ('course labels', KEEP): ['sesión 2', 'Sesión 3 de 8', 'Anexo D', 'módulo IV', 'CLIC 81'],
        ('grant codes', KEEP): ['PX-2024-II-118', 'convocatoria 2025-B'],
        ('persons', REDACT): ['Julián', 'Esparza', 'Ruelas'],
        ('personal ids', REDACT): ['EARJ990314HDFSLL07', '412938771'],
    },
    'q10': {
        ('towns', KEEP): ['Xochitepec', 'Tlapa', 'Jiutepec'],
        ('persons+titles', REDACT): ['Rosaura', 'Fernando', 'Vázquez', 'Lucrecia', 'Abundio', 'Cázares'],
        ('addresses', REDACT): ['Hidalgo 45', 'Las Flores', 'Morelos 120', 'El Mezquite', 'Cereso'],
    },
    'kinship': {
        ('towns', KEEP): ['Cuautla'],
        ('persons', REDACT): ['Lucía', 'Arnulfo', 'mi mamá', 'mi abuelo', 'mi tío'],
    },
    'xochi2': {
        ('towns', KEEP): ['Xochitepec'],
        ('persons', REDACT): ['Lucía', 'Rangel', 'Gonzalo', 'MaríaLópez', 'Mi mamá'],
    },
    # Audit follow-up, 2026-10-28: a named workplace or school beside a person or
    # a cargo is reported (the whole phrase must not survive); bare institution
    # names and towns stay. Names differ from the prompt's own examples.
    'q24-workplace': {
        ('workplace+person', REDACT): ['clínica dental Sonrisa Clara'],
        ('school+person, small town', REDACT): ['telesecundaria Emiliano Zapata'],
        ('cargo+institution', REDACT): ['DIF municipal de Ocuituco'],
        ('bare institutions', KEEP): ['apoyo del DIF y del IMSS', 'un PILARES de la alcaldía', 'la UNAM'],
        ('towns', KEEP): ['Temixco', 'Huazulco', 'Tetecala'],
    },
    'staff-draft': {
        ('persons', REDACT): ['Rodolfo', 'Quintanar', 'Diego', 'Villanueva'],
    },
}


def count(hay, w):
    return hay.count(w)


rows = []
for name, classes in TERMS.items():
    labels = sorted({os.path.basename(p)[len(name) + 1:-6] for p in glob.glob(os.path.join(OUT, f'{name}-*.jsonl'))} - {''}, key=lambda l: (l != 'old', l))
    for prompt in labels:
        path = os.path.join(OUT, f'{name}-{prompt}.jsonl')
        if not os.path.exists(path):
            continue
        runs = [json.loads(l) for l in open(path)]
        src = open(os.path.join(INPUTS, f'{name}.txt')).read()
        for (cls, want), terms in classes.items():
            per_run = []
            for r in runs:
                out = r.get('redactedText') or ''
                kept = [t for t in terms if count(src, t) > 0 and count(out, t) >= count(src, t)]
                per_run.append(kept)
            present = [t for t in terms if count(src, t) > 0]
            rows.append({
                'text': name, 'prompt': prompt, 'class': cls, 'want': want,
                'kept': '/'.join(f'{len(k)}' for k in per_run) + f' of {len(present)}',
                'wrong': sorted({t for k in per_run for t in (k if want == REDACT else [x for x in present if x not in k])}),
            })
        res = ['%s%s' % (r['status'], (':' + r['stage']) if r.get('stage') else '') for r in runs]
        secs = [round(r['totalMs'] / 1000, 1) for r in runs]
        calls = [r['nCalls'] for r in runs]
        maxcall = [r['maxCallMs'] for r in runs]
        omitted = [(r.get('redactedText') or '').count('[Dato omitido]') for r in runs]
        rows.append({'text': name, 'prompt': prompt, 'class': 'RUN', 'want': '',
                     'kept': f"result {res} secs {secs} calls {calls} maxCallMs {maxcall} [Dato omitido] {omitted} fallbackErrors {[r['nErrors'] for r in runs]}",
                     'wrong': []})

for r in rows:
    print(f"{r['text']:12} {r['prompt']:3} {r['class']:20} {r['want']:6} {r['kept']:30} {', '.join(r['wrong'])}")
