#!/usr/bin/env python3
"""Regenerate the betterleaks rule pack from Betterleaks' default config (MIT).

    python3 import_betterleaks.py <commit> [betterleaks.toml]

With a local copy of config/betterleaks.toml at that commit, it is read
instead of fetched.

Betterleaks rules are written for git history: their filters are Expr
programs over file paths, git attributes and live HTTP validation. Only
what holds for a single piece of text is kept: the pattern, its keywords,
its value group, its entropy floor and the value-only discard lists. Path,
validation and token-efficiency (BPE) logic is dropped; rules that only
make sense with it (generic-*, path-scoped, id-only components) are skipped.
"""
import json
import re
import sys
import tomllib
import urllib.request
from pathlib import Path

REPO = "https://github.com/betterleaks/betterleaks"
COPYRIGHT = "Copyright (c) 2026 Zachary Rice"
# Rules covered by evot's own rules, with wider or CJK context.
SKIP = {"generic-api-key", "generic-credential-uri", "generic-password", "generic-username"}

LIST = r'\[((?:[^\[\]]|\[[^\]]*\])*)\]'
SECRET_LIST = re.compile(r'(matchesAny|containsAny)\(finding\["secret"\],\s*' + LIST + r'\s*\)', re.S)
ENTROPY = re.compile(r'^\s*entropy\(finding\["secret"\]\)\s*(<=|<)\s*([0-9.]+)')


# Go RE2's perl classes are ASCII; Rust's are Unicode (and a Unicode \w in
# a bounded repeat compiles to a huge automaton). POSIX classes are ASCII in
# both, so each perl class becomes one.
PERL = {'w': 'word', 'd': 'digit', 's': 'space'}


QUANTIFIER = re.compile(r'\{[0-9]+(?:,[0-9]*)?\}')


def go_to_rust(pattern: str) -> str:
    out, i, in_class = [], 0, False
    while i < len(pattern):
        c = pattern[i]
        if c == '\\' and i + 1 < len(pattern):
            e = pattern[i + 1]
            name = PERL.get(e.lower())
            if name:
                neg = '^' if e.isupper() else ''
                out.append(f'[:{neg}{name}:]' if in_class else f'[{neg}[:{name}:]]')
            else:
                out.append(c + e)
            i += 2
            continue
        if c == '{' and not in_class and not QUANTIFIER.match(pattern, i):
            # RE2 reads a brace that is no repetition as itself; Rust needs \{.
            out.append('\\{')
            i += 1
            continue
        if c == '[' and not in_class:
            in_class = True
            out.append(c)
            # A leading ] or ^] is literal.
            j = i + 1
            if pattern[j:j + 1] == '^':
                out.append('^')
                j += 1
            if pattern[j:j + 1] == ']':
                out.append(']')
                j += 1
            i = j
            continue
        if c == '[' and in_class and pattern[i:i + 2] == '[:':
            end = pattern.index(':]', i) + 2
            out.append(pattern[i:end])
            i = end
            continue
        if c == ']' and in_class:
            in_class = False
        out.append(c)
        i += 1
    return ''.join(out)


# Upstream writes (?i)^true|false|null$, which by precedence discards any
# value merely containing "false"; the intent is a whole-value match.
FIXES = {'(?i)^true|false|null$': '(?i)^(?:true|false|null)$'}


def items(body: str) -> list[str]:
    """Backtick regexes and double-quoted strings of an Expr list."""
    out = re.findall(r'`([^`]*)`', body)
    out += [json.loads(f'"{s}"') for s in re.findall(r'"((?:[^"\\]|\\.)*)"', re.sub(r'`[^`]*`', '', body))]
    return out


def discards(expr: str) -> tuple[list[str], list[str]]:
    """Value-only discard lists of a filter that is a plain disjunction."""
    if 'let ' in expr or '&&' in expr or 'setConfidence' in expr:
        return [], []
    regexes, contains = [], []
    for fn, body in SECRET_LIST.findall(expr):
        (regexes if fn == 'matchesAny' else contains).extend(items(body))
    return regexes, contains


def kind(rule_id: str) -> str:
    rule_id = rule_id.replace('1password', 'onepw')
    if 'private-key' in rule_id:
        return 'PRIVATE_KEY'
    if 'password' in rule_id:
        return 'PASSWORD'
    if 'jwt' in rule_id or 'token' in rule_id or rule_id.endswith('-pat') or '-pat-' in rule_id:
        return 'TOKEN'
    if any(word in rule_id for word in ('secret', 'connection-string', 'uri', 'dsn', 'webhook')):
        return 'SECRET'
    return 'API_KEY'


def stopwords(rules: list[dict]) -> list[str]:
    generic = next(r for r in rules if r['id'] == 'generic-api-key')
    lists = [items(body) for fn, body in SECRET_LIST.findall(generic['filter']) if fn == 'containsAny']
    return sorted(set(max(lists, key=len)))


def alternation(regexes: list[str]) -> str:
    return '|'.join(f'(?:{r})' for r in regexes)


def main() -> None:
    commit = sys.argv[1]
    if len(sys.argv) > 2:
        text = Path(sys.argv[2]).read_text()
    else:
        url = f"https://raw.githubusercontent.com/betterleaks/betterleaks/{commit}/config/betterleaks.toml"
        text = urllib.request.urlopen(url, timeout=60).read().decode()
    config = tomllib.loads(text)
    global_regexes, global_contains = discards(config.get('filter', ''))
    global_regexes = [go_to_rust(FIXES.get(r, r)) for r in global_regexes]
    rules = []
    for rule in config['rules']:
        if rule['id'] in SKIP or 'regex' not in rule or rule.get('skipReport') or 'path' in rule:
            continue
        expr = rule.get('filter', '')
        unless: list = ['betterleaks_discard', 'betterleaks_discard_contains']
        entropy = ENTROPY.match(expr)
        if entropy:
            # entropy <= x drops x itself; entropy_below is strict.
            limit = float(entropy.group(2)) + (1e-9 if entropy.group(1) == '<=' else 0.0)
            unless.append({'entropy_below': limit})
        regexes, contains = discards(expr)
        if regexes:
            unless.append({'value': alternation([go_to_rust(r) for r in regexes])})
        if contains:
            unless.append({'contains': contains})
        out = {
            'id': f"betterleaks.{rule['id']}",
            'kind': kind(rule['id']),
            'confidence': rule['confidence'],
            'regex': go_to_rust(rule['regex']),
            'keywords': [k.lower() for k in rule.get('keywords', [])],
            'unless': unless,
        }
        if rule.get('valueGroup'):
            out['group'] = rule['valueGroup']
        rules.append(out)
    pack = {
        'schema_version': 1,
        'id': 'betterleaks',
        'source': {
            'name': 'Betterleaks',
            'url': REPO,
            'license': 'MIT',
            'copyright': COPYRIGHT,
            'commit': commit,
        },
        'lists': {'betterleaks_stopwords': stopwords(config['rules'])},
        'checks': {
            'betterleaks_discard': {'value': alternation(global_regexes)},
            'betterleaks_discard_contains': {'contains': global_contains},
        },
        'rules': rules,
    }
    target = Path(__file__).with_name('betterleaks.json')
    target.write_text(json.dumps(pack, indent=1, ensure_ascii=False) + '\n')
    print(f"{len(rules)} rules, {len(pack['lists']['betterleaks_stopwords'])} stopwords -> {target}")


if __name__ == '__main__':
    main()
