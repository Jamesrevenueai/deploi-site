import sys, os; sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from sbq import q
R='makqaqzlylhckijdbjzi'; D=__import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), '..', '..', 'supabase', 'migrations')
LAUNCH=['20261028000028_merchant_engine.sql','20261028000029_early_access_leads.sql','20261028000030_agents.sql','20261028000031_email.sql','20261028000032_agent_platform.sql','20261029000032_store_access.sql','20261029000033_competitor_watch.sql','20261029000034_agent_library.sql']
mode=sys.argv[1]
done={r['name'] for r in q(R,'select name from _migrations',True)}
assert '20261020000016_service_role_auth_users.sql' in done, 'prerequisite missing'
todo=[f for f in LAUNCH if f not in done]
print('to apply:',todo)
if mode=='dry-run':
    body='\n'.join(open(os.path.join(D,f)).read()+f"\n;insert into _migrations (name) values ('{f}');" for f in todo)
    r=q(R,f"begin;\n{body}\nselect count(*)::int as n from _migrations;\nrollback;")
    print('dry-run ok; ledger inside the transaction would hold', r)
    print('ledger after rollback:', q(R,'select count(*) n from _migrations',True))
elif mode=='apply':
    for f in todo:
        q(R,f"begin;\n{open(os.path.join(D,f)).read()}\n;insert into _migrations (name) values ('{f}');\ncommit;")
        print('applied',f)
    print('ledger:', [r['name'] for r in q(R,'select name from _migrations order by name',True)][-9:])
