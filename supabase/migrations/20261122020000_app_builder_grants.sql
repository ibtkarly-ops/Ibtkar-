-- App builder functions are for signed-in users only (each also checks is_super()/ownership inside).
revoke execute on function public.admin_set_integration_secret(text, text) from public, anon;
revoke execute on function public.integration_secret_status() from public, anon;
revoke execute on function public.can_build_apps() from public, anon;
revoke execute on function public.guard_app_insert() from public, anon, authenticated;
grant execute on function public.admin_set_integration_secret(text, text) to authenticated;
grant execute on function public.integration_secret_status() to authenticated;
grant execute on function public.can_build_apps() to authenticated;
