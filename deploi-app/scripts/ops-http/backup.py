"""Logical backup of a Supabase project over the Management API: catalog, DDL, applied migration files, all rows as JSON."""
import sys, json, hashlib, os, subprocess, datetime
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from sbq import q
R=sys.argv[1]; OUT=sys.argv[2]; REPO=__import__('os').path.abspath(__import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), '..', '..', '..')); MAIN='b8aad244c546b9e2c2ab631194cf78c2aa419cc9'
os.makedirs(f'{OUT}/data',exist_ok=True); os.makedirs(f'{OUT}/schema/migrations',exist_ok=True)
def ro(sql): return q(R,sql,True)
def w(path,obj):
    p=f'{OUT}/{path}'
    with open(p,'w') as f:
        f.write(obj if isinstance(obj,str) else json.dumps(obj,indent=1,default=str,sort_keys=True))
taken=datetime.datetime.utcnow().isoformat()+'Z'
ledger=ro("select name, applied_at from _migrations order by name")
tables=[r['t'] for r in ro("select c.relname t from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 1")]
cat={}
cat['columns']=ro("""select table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default, character_maximum_length
 from information_schema.columns where table_schema='public' order by table_name, ordinal_position""")
cat['coltypes']=ro("""select c.relname t, a.attname col, format_type(a.atttypid,a.atttypmod) typ, a.attnotnull nn, pg_get_expr(d.adbin,d.adrelid) def, a.attnum n
 from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace s on s.oid=c.relnamespace left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
 where s.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped order by 1,6""")
cat['constraints']=ro("""select conrelid::regclass::text t, conname, contype, pg_get_constraintdef(oid) def from pg_constraint where connamespace='public'::regnamespace and conrelid<>0 order by 1,2""")
cat['indexes']=ro("select tablename t, indexname, indexdef from pg_indexes where schemaname='public' order by 1,2")
cat['policies']=ro("select tablename t, policyname, permissive, roles::text roles, cmd, qual, with_check from pg_policies where schemaname='public' order by 1,2")
cat['rls']=ro("select relname t, relrowsecurity rls, relforcerowsecurity force from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1")
cat['triggers']=ro("select tgrelid::regclass::text t, tgname, pg_get_triggerdef(oid) def from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace='public'::regnamespace) order by 1,2")
cat['functions']=ro("select p.proname, pg_get_function_identity_arguments(p.oid) args, pg_get_functiondef(p.oid) def from pg_proc p where p.pronamespace='public'::regnamespace order by 1,2")
cat['auth_triggers']=ro("select tgrelid::regclass::text t, tgname, pg_get_triggerdef(oid) def from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace='auth'::regnamespace) order by 1,2")
cat['grants']=ro("select table_name t, grantee, string_agg(privilege_type, ',' order by privilege_type) privs from information_schema.role_table_grants where table_schema='public' group by 1,2 order by 1,2")
cat['views']=ro("select viewname, definition from pg_views where schemaname='public' order by 1")
cat['sequences']=ro("select sequencename, last_value from pg_sequences where schemaname='public' order by 1")
cat['types']=ro("select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) labels from pg_type t join pg_enum e on e.enumtypid=t.oid where t.typnamespace='public'::regnamespace group by 1 order by 1")
w('schema/catalog.json',cat)
# readable DDL regenerated from the catalog
ddl=[f'-- DDL regenerated from the catalog of {R} at {taken}. Restore path: the migration files in schema/migrations (the exact ledger), then data/.\n']
for t in cat['types']: ddl.append(f"create type public.{t['typname']} as enum ({', '.join(repr(x) for x in t['labels'].split(','))});")
for t in tables:
    cols=[c for c in cat['coltypes'] if c['t']==t]
    body=',\n'.join(f"  {c['col']} {c['typ']}{' not null' if c['nn'] else ''}{(' default '+c['def']) if c['def'] else ''}" for c in cols)
    ddl.append(f'create table public.{t} (\n{body}\n);')
for c in cat['constraints']: ddl.append(f"alter table {c['t']} add constraint {c['conname']} {c['def']};")
for i in cat['indexes']:
    if not any(c['conname']==i['indexname'] for c in cat['constraints']): ddl.append(i['indexdef']+';')
for f in cat['functions']: ddl.append(f['def'].rstrip()+';')
for t in cat['triggers']+cat['auth_triggers']: ddl.append(t['def']+';')
for r in cat['rls']:
    if r['rls']: ddl.append(f"alter table public.{r['t']} enable row level security;")
for p in cat['policies']:
    s=f"create policy {json.dumps(p['policyname'])} on public.{p['t']} as {p['permissive'].lower()} for {p['cmd'].lower()} to {p['roles'].strip('{}')}"
    if p['qual']: s+=f" using ({p['qual']})"
    if p['with_check']: s+=f" with check ({p['with_check']})"
    ddl.append(s+';')
for v in cat['views']: ddl.append(f"create view public.{v['viewname']} as {v['definition']}")
w('schema/ddl.sql','\n\n'.join(ddl)+'\n')
for r in ledger:
    src=subprocess.run(['git','-C',REPO,'show',f"{MAIN}:deploi-app/supabase/migrations/{r['name']}"],capture_output=True)
    if src.returncode: raise SystemExit(f"missing migration file {r['name']} on main")
    open(f"{OUT}/schema/migrations/{r['name']}",'wb').write(src.stdout)
src=subprocess.run(['git','-C',REPO,'show',f"{MAIN}:deploi-app/supabase/local/0000_auth_shim.sql"],capture_output=True)
if not src.returncode: open(f"{OUT}/schema/0000_auth_shim_for_plain_postgres.sql",'wb').write(src.stdout)
counts={}
for t in tables:
    rows=ro(f"select coalesce(json_agg(x order by x::text),'[]'::json) j from public.{t} x")[0]['j']
    if isinstance(rows,str): rows=json.loads(rows)
    w(f'data/public.{t}.json',rows); counts[f'public.{t}']=len(rows)
au=ro("select coalesce(json_agg(x order by x.created_at),'[]'::json) j from (select id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, last_sign_in_at, is_anonymous from auth.users) x")[0]['j']
if isinstance(au,str): au=json.loads(au)
w('data/auth.users.json',au); counts['auth.users']=len(au)
live={r['t']:r['n'] for r in ro("""select n.nspname||'.'||c.relname t, (xpath('/row/c/text()', query_to_xml('select count(*) as c from '||n.nspname||'.'||quote_ident(c.relname), false, true, '')))[1]::text::int n
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where (n.nspname='public' and c.relkind='r') or (n.nspname='auth' and c.relname='users')""")}
mismatch={k:(counts[k],live.get(k)) for k in counts if counts[k]!=live.get(k)}
files={}
for root,_,fs in os.walk(OUT):
    for f in sorted(fs):
        p=os.path.join(root,f); files[os.path.relpath(p,OUT)]=hashlib.sha256(open(p,'rb').read()).hexdigest()
man={'project_ref':R,'taken_at':taken,'method':'Supabase Management API (HTTPS), read-only queries','ledger':ledger,'row_counts':counts,
     'row_counts_recount_after_export':live,'count_mismatches':mismatch,'files_sha256':files,
     'note':'auth.users is exported without password hashes or tokens. Storage held no app data.'}
w('manifest.json',man)
print(json.dumps({'tables':len(tables),'rows':sum(counts.values()),'mismatches':mismatch},indent=1))
