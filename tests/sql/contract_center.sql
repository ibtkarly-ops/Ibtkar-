-- Run with the Supabase SQL editor / MCP execute_sql. Everything is rolled back at the end (the last statement raises RESULT ...).
-- Needs: one customer who owns a draft site with html (cust, site), a second user (other) and the super admin (sup).
do $$
declare
  cust uuid := '62d97708-baae-4ca6-9a24-fdcefa05157b'; sup uuid := 'b7789496-689c-4b7b-a812-b5d19ea47985'; site uuid := '0a668e15-ed1d-4250-96db-2f98fc2a0377';
  res text := ''; v_tpl uuid; v_ver uuid; v_c uuid; v_j jsonb; n int;
begin
  insert into contract_templates(id, active, auto_send) values (gen_random_uuid(), true, true) returning id into v_tpl;
  -- no active version yet: delivery fails loudly and is logged, nothing is sent
  v_j := issue_contract_for_site(site); res := res || 'noversion=' || v_j::text || '; ';
  insert into contract_template_versions(template_id, version, pages, layout, original_sha256) values (v_tpl, 1, '[{"path":"x","w":1000,"h":1000,"mime":"image/png","sha256":"a"}]', '{}', 'abc') returning id into v_ver;
  update contract_templates set active_version_id = v_ver where id = v_tpl;
  -- auto-send OFF => skipped, no contract
  update contract_templates set auto_send = false;
  v_j := issue_contract_for_site(site); res := res || 'autooff=' || v_j::text || '; ';
  update contract_templates set auto_send = true;
  -- idempotent issue
  v_j := issue_contract_for_site(site); res := res || 'issue1=' || (v_j->>'ok') || '; ';
  v_j := issue_contract_for_site(site); res := res || 'issue2=' || (v_j->>'ok') || ' same=' || coalesce(v_j->>'existing', v_j->>'reason', '?') || '; ';
  select count(*) into n from project_contracts where website_id = site; res := res || 'contracts_for_site=' || n || '; ';
  select id into v_c from project_contracts where website_id = site;
  -- a second live contract for the same site is impossible
  begin insert into project_contracts(contract_number, website_id, customer_id, template_version_id) values ('T-DUP', site, cust, v_ver); res := res || 'FAIL dup; '; exception when unique_violation then res := res || 'ok dup blocked; '; end;
  -- the customer cannot forge a status, a signature, or an approval
  perform set_config('request.jwt.claims', json_build_object('sub', cust, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update project_contracts set status = 'approved' where id = v_c; get diagnostics n = row_count; res := res || 'forge_update_rows=' || n || '; ';
  begin insert into project_contracts(contract_number, website_id, customer_id, template_version_id, status) values ('T-F', site, cust, v_ver, 'approved'); res := res || 'FAIL forge insert; '; exception when others then res := res || 'ok forge insert blocked; '; end;
  begin insert into contract_signatures(contract_id, customer_id, signer_name, signature_path, original_sha256, final_sha256, consent_text) values (v_c, cust, 'x', 'p', 'a', 'b', 'c'); res := res || 'FAIL forge sig; '; exception when others then res := res || 'ok forge sig blocked; '; end;
  begin perform ct_finalize_signature(v_c, cust, 'x', 'p', null, 'f', 'h', '', ''); res := res || 'FAIL customer finalize; '; exception when others then res := res || 'ok customer finalize blocked; '; end;
  begin perform ct_admin_action(v_c, 'approve', null); res := res || 'FAIL customer approve; '; exception when others then res := res || 'ok customer approve:' || sqlerrm || '; '; end;
  begin perform ct_set_template_flags(false, false); res := res || 'FAIL customer flags; '; exception when others then res := res || 'ok customer flags:' || sqlerrm || '; '; end;
  select count(*) into n from project_contracts; res := res || 'customer_sees=' || n || '; ';
  -- publishing is still blocked
  begin update websites set status = 'published' where id = site; res := res || 'FAIL publish; '; exception when others then res := res || 'ok publish:' || sqlerrm || '; '; end;
  reset role;
  -- another user sees nothing
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from project_contracts; res := res || 'stranger_sees=' || n || '; ';
  select count(*) into n from contract_events; res := res || 'stranger_events=' || n || '; ';
  reset role;
  -- immutability
  begin update contract_template_versions set original_sha256 = 'z' where id = v_ver; res := res || 'FAIL version edit; '; exception when others then res := res || 'ok version immutable; '; end;
  begin delete from contract_events where contract_id = v_c; res := res || 'FAIL event delete; '; exception when others then res := res || 'ok events immutable; '; end;
  -- state machine: cannot approve an unsigned contract, cannot jump back
  begin update project_contracts set status = 'approved' where id = v_c; res := res || 'FAIL jump; '; exception when others then res := res || 'ok jump:' || sqlerrm || '; '; end;
  begin update project_contracts set status = 'signed' where id = v_c; res := res || 'FAIL signed w/o signature; '; exception when others then res := res || 'ok signed needs signature:' || sqlerrm || '; '; end;
  raise exception 'RESULT %', res;
end $$;
