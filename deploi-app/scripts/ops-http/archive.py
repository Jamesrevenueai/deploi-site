"""archive-care-tables.ts (report / dump / apply / verify) ported to the Supabase Management API. Same tables, functions, checks."""
import sys, json, hashlib, os, re; sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from sbq import q
R=os.environ.get('ARCHIVE_REF','makqaqzlylhckijdbjzi'); S='archive'
src=open(__import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), '..', 'archive-care-tables.ts')).read()
def lst(name): return re.findall(r"'([a-z_0-9]+)'", src.split(f'export const {name} = [',1)[1].split('] as const',1)[0])
CARE=lst('CARE_TABLES'); FNS=lst('CARE_FUNCTIONS'); KEEP=lst('KEEP_TABLES')
arr=lambda xs: "ARRAY["+",".join(f"'{x}'" for x in xs)+"]::text[]"
def present(schema='public'): return [r['tablename'] for r in q(R,f"select tablename from pg_tables where schemaname='{schema}' and tablename = any({arr(CARE)}) order by 1",True)]
def fns(): return q(R,f"select p.oid::text oid, p.proname name, pg_get_function_identity_arguments(p.oid) args from pg_proc p where p.pronamespace='public'::regnamespace and p.proname = any({arr(FNS)}) order by 2,3",True)
def counts(schema,ts):
    if not ts: return {}
    r=q(R," union all ".join(f"select '{t}' t, count(*)::int n from {schema}.\"{t}\"" for t in ts),True); return {x['t']:x['n'] for x in r}
def blockers(ts):
    out=[f'{k} is on the keep list' for k in KEEP if k in ts]
    A=arr(ts); F=arr(FNS)
    for r in q(R,f"select conrelid::regclass::text a, confrelid::regclass::text b from pg_constraint where contype='f' and confrelid::regclass::text = any({A}) and conrelid::regclass::text <> all({A})",True): out.append(f"foreign key: {r['a']} references {r['b']}")
    for r in q(R,f"select distinct c.relname v, d.refobjid::regclass::text t from pg_rewrite rw join pg_depend d on d.objid=rw.oid and d.classid='pg_rewrite'::regclass join pg_class c on c.oid=rw.ev_class where d.refobjid::regclass::text = any({A}) and c.oid<>d.refobjid",True): out.append(f"view {r['v']} reads {r['t']}")
    rx="\\m(" + "|".join(ts) + ")\\M"
    for r in q(R,f"select polrelid::regclass::text t, polname p from pg_policy where polrelid::regclass::text <> all({A}) and (coalesce(pg_get_expr(polqual,polrelid),'')||coalesce(pg_get_expr(polwithcheck,polrelid),'')) ~* '{rx}'",True): out.append(f"policy {r['p']} on {r['t']}")
    for r in q(R,f"select p.oid::regprocedure::text f from pg_proc p where p.pronamespace='public'::regnamespace and p.proname <> all({F}) and p.prosrc ~* '{rx}'",True): out.append(f"function {r['f']} mentions a care table")
    for r in q(R,f"select tgrelid::regclass::text t, tgname g, p.proname f from pg_trigger tg join pg_proc p on p.oid=tg.tgfoid where not tg.tgisinternal and p.pronamespace='public'::regnamespace and p.proname = any({F}) and tgrelid::regclass::text <> all({A})",True): out.append(f"trigger {r['g']} on {r['t']} uses {r['f']}")
    for r in q(R,f"select po.polrelid::regclass::text t, po.polname p, pr.proname f from pg_policy po join pg_depend d on d.objid=po.oid and d.classid='pg_policy'::regclass join pg_proc pr on pr.oid=d.refobjid where pr.pronamespace='public'::regnamespace and pr.proname = any({F}) and po.polrelid::regclass::text <> all({A})",True): out.append(f"policy {r['p']} on {r['t']} uses {r['f']}")
    return out
cmd=sys.argv[1]; OUT=os.environ.get('ARCHIVE_OUT','./care-dump')
if cmd=='report':
    ts=present(); c=counts('public',ts)
    print(len(ts),'care tables present', c, 'total', sum(c.values())); print('functions', [f['name'] for f in fns()]); print('blockers', blockers(ts) or 'none')
elif cmd=='dump':
    os.makedirs(OUT,exist_ok=True); ts=present(); c=counts('public',ts)
    data={t: q(R,f"select coalesce(json_agg(x),'[]'::json) j from public.\"{t}\" x",True)[0]['j'] for t in ts}
    data={t:(json.loads(v) if isinstance(v,str) else v) for t,v in data.items()}
    fdefs=q(R,f"select p.proname, pg_get_functiondef(p.oid) def from pg_proc p where p.pronamespace='public'::regnamespace and p.proname = any({arr(FNS)})",True)
    blob=json.dumps({'tables':data,'functions':fdefs},sort_keys=True,default=str).encode()
    open(f'{OUT}/care-tables.json','wb').write(blob)
    sha=hashlib.sha256(blob).hexdigest()
    open(f'{OUT}/care-tables.json.sha256','w').write(f'{sha}  care-tables.json\n')
    open(f'{OUT}/care-tables.json.counts.tsv','w').write(''.join(f'{t}\t{c[t]}\n' for t in ts))
    assert all(len(data[t])==c[t] for t in ts); print('dump', sha, sum(c.values()),'rows', len(ts),'tables')
elif cmd=='apply':
    man={l.split('\t')[0]:int(l.split('\t')[1]) for l in open(f'{OUT}/care-tables.json.counts.tsv') if l.strip()}
    sha=open(f'{OUT}/care-tables.json.sha256').read().split()[0]
    assert hashlib.sha256(open(f'{OUT}/care-tables.json','rb').read()).hexdigest()==sha
    ts=present(); fs=fns(); bl=blockers(ts)
    if bl: raise SystemExit('refusing: '+str(bl))
    assert set(ts)==set(man), 'tables differ from dump'
    roles=[r['rolname'] for r in q(R,"select rolname from pg_roles where rolname in ('anon','authenticated','service_role') order by 1",True)]
    s=["begin;"]
    s.append("do $$ declare n bigint; begin "+" ".join(f"select count(*) into n from public.\"{t}\"; if n <> {man[t]} then raise exception 'data changed since dump: {t}'; end if;" for t in ts)+" end $$;")
    s+= [f"create schema if not exists {S};",
      f"create table if not exists {S}._archive_log (table_name text primary key, rows_at_archive bigint not null, archived_at timestamptz not null default now(), dump_sha256 text not null);",
      f"create table if not exists {S}._archive_grants (table_name text not null, grantee text not null, privilege text not null, primary key (table_name, grantee, privilege));",
      f"create table if not exists {S}._archive_functions (name text not null, args text not null, public_execute boolean not null, grantees text[] not null default '{{}}', archived_at timestamptz not null default now(), primary key (name, args));"]
    for t in ts:
        s.append(f"insert into {S}._archive_grants (table_name, grantee, privilege) select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='{t}' and grantee = any({arr(roles)}) on conflict do nothing;")
        s.append(f"alter table public.\"{t}\" set schema {S};")
        s.append(f"insert into {S}._archive_log (table_name, rows_at_archive, dump_sha256) values ('{t}', {man[t]}, '{sha}');")
    for f in fs:
        s.append(f"""insert into {S}._archive_functions (name, args, public_execute, grantees) select '{f['name']}', '{f['args']}',
          coalesce(bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE'), false),
          coalesce(array_agg(distinct r.rolname) filter (where a.grantee <> 0 and a.privilege_type = 'EXECUTE' and r.rolname = any({arr(roles)})), '{{}}')
          from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a left join pg_roles r on r.oid = a.grantee where p.oid = {f['oid']}::oid;""")
        s.append(f"alter function public.\"{f['name']}\"({f['args']}) set schema {S};")
        s.append(f"revoke all on function {S}.\"{f['name']}\"({f['args']}) from public;")
        for r in roles: s.append(f"revoke all on function {S}.\"{f['name']}\"({f['args']}) from \"{r}\";")
    s+= [f"revoke all on schema {S} from public;", f"revoke all on all tables in schema {S} from public;"]
    for r in roles: s+= [f"revoke all on schema {S} from \"{r}\";", f"revoke all on all tables in schema {S} from \"{r}\";", f"revoke all on all sequences in schema {S} from \"{r}\";"]
    s.append("do $$ declare n bigint; begin "+" ".join(f"select count(*) into n from {S}.\"{t}\"; if n <> {man[t]} then raise exception 'count mismatch after move: {t}'; end if;" for t in ts)+
             f" if exists (select 1 from pg_tables where schemaname='public' and tablename = any({arr(CARE)})) then raise exception 'care table still in public'; end if; end $$;")
    s.append("commit;")
    q(R,"\n".join(s)); print(f'archived {len(ts)} tables ({sum(man.values())} rows) and {len(fs)} functions into {S}; roles revoked: {roles}; dump sha256 {sha}')
elif cmd=='verify':
    log=q(R,f"select table_name, rows_at_archive::int n from {S}._archive_log order by 1",True); fl=q(R,f"select name, args from {S}._archive_functions",True)
    roles=[r['rolname'] for r in q(R,"select rolname from pg_roles where rolname in ('anon','authenticated','service_role')",True)]
    c=counts(S,[r['table_name'] for r in log]); probs=[f"{r['table_name']} count" for r in log if c[r['table_name']]!=r['n']]
    for r in log:
        for role in roles:
            x=q(R,f"select has_table_privilege('{role}', '{S}.\"{r['table_name']}\"', 'select') or has_table_privilege('{role}', '{S}.\"{r['table_name']}\"', 'insert') x",True)[0]['x']
            if x: probs.append(f'{role} can reach {r["table_name"]}')
    for f in fl:
        for role in roles:
            x=q(R,f"select has_function_privilege('{role}', p.oid, 'execute') x from pg_proc p where p.pronamespace='{S}'::regnamespace and p.proname='{f['name']}' and pg_get_function_identity_arguments(p.oid)='{f['args']}'",True)
            if not x: probs.append(f"{f['name']} not in {S}")
            elif x[0]['x']: probs.append(f"{role} can run {f['name']}")
    for role in roles:
        if q(R,f"select has_schema_privilege('{role}','{S}','usage') x",True)[0]['x']: probs.append(f'{role} has usage on {S}')
    if present() or fns(): probs.append('still in public')
    print('verify', 'FAILED '+str(probs) if probs else f"ok: {len(log)} tables ({sum(r['n'] for r in log)} rows, counts match), {len(fl)} functions; {'/'.join(roles)} have no access")
