alter table public.depositos_blockchain
add column if not exists token_symbol text not null default 'USDT';
