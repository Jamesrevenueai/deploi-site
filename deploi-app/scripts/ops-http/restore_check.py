import json, os, subprocess, sys
B=sys.argv[1]; DB='deploi_restore_check'
env=dict(os.environ, PGPASSWORD='postgres')
def psql(sql, db=DB, capture=True):
    p=subprocess.run(['psql','-h','127.0.0.1','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-qAt','-c',sql],env=env,capture_output=True,text=True)
    if p.returncode: raise SystemExit(f'psql failed: {p.stderr[:600]}')
    return p.stdout
def psqlf(path):
    p=subprocess.run(['psql','-h','127.0.0.1','-U','postgres','-d',DB,'-v','ON_ERROR_STOP=1','-q','-f',path],env=env,capture_output=True,text=True)
    if p.returncode: raise SystemExit(f'{path}: {p.stderr[:600]}')
psql(f'drop database if exists {DB} with (force)','postgres'); psql(f'create database {DB}','postgres')
psqlf(f'{B}/schema/0000_auth_shim_for_plain_postgres.sql')
psql("create table _migrations (name text primary key, applied_at timestamptz default now())")
man=json.load(open(f'{B}/manifest.json'))
for r in man['ledger']:
    psqlf(f"{B}/schema/migrations/{r['name']}")
# load rows: auth.users first, then public tables, with triggers and FK checks off as pg_restore --disable-triggers would
loads=['auth.users']+[k for k in man['row_counts'] if k.startswith('public.')]
sql=["set session_replication_role = replica;","truncate _migrations;"]
for t in loads:
    path=f'{B}/data/{t}.json'
    data=open(path).read().replace("$J$","")
    sql.append(f"insert into {t} select * from json_populate_recordset(null::{t}, $J${data}$J$) on conflict do nothing;" if t!='public._migrations' else f"insert into {t} select * from json_populate_recordset(null::{t}, $J${data}$J$);")
open('load.sql','w').write('\n'.join(sql))
psqlf('load.sql')
ok=True
for t,n in man['row_counts'].items():
    got=int(psql(f'select count(*) from {t}').strip())
    if got!=n: ok=False; print('COUNT MISMATCH',t,n,got)
cat=json.load(open(f'{B}/schema/catalog.json'))
prod={(c['t'],c['col'],c['typ']) for c in cat['coltypes']}
loc={tuple(l.split('|')) for l in psql("""select c.relname, a.attname, format_type(a.atttypid,a.atttypmod) from pg_attribute a join pg_class c on c.oid=a.attrelid
 where c.relnamespace='public'::regnamespace and c.relkind='r' and a.attnum>0 and not a.attisdropped""").strip().splitlines()}
diff=sorted(prod^loc)
if diff: ok=False; print('COLUMN DIFF', diff[:20])
pol_prod={(p['t'],p['policyname']) for p in cat['policies']}
pol_loc={tuple(l.split('|')) for l in psql("select tablename, policyname from pg_policies where schemaname='public'").strip().splitlines()}
if pol_prod^pol_loc: ok=False; print('POLICY DIFF', sorted(pol_prod^pol_loc)[:20])
print('restore check', 'PASSED' if ok else 'FAILED', f"{len(man['row_counts'])} tables, {sum(man['row_counts'].values())} rows, {len(prod)} columns, {len(pol_prod)} policies")
