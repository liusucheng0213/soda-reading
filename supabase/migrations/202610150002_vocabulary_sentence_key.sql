-- Keep two contextual senses of the same word in one article.
-- sentence_key matches packages/core sentenceKey(): djb2 over UTF-8, low 32 bits.

create or replace function public.soda_sentence_key(input text)
returns text
language plpgsql
immutable
as $$
declare
  raw bytea;
  hash bigint := 5381;
  index integer;
  byte integer;
begin
  raw := convert_to(
    btrim(lower(regexp_replace(coalesce(input, ''), '\s+', ' ', 'g'))),
    'UTF8'
  );
  if octet_length(raw) > 0 then
    for index in 0..octet_length(raw) - 1 loop
      byte := get_byte(raw, index);
      hash := ((hash * 33) & 4294967295) # byte;
    end loop;
  end if;
  return lpad(to_hex(hash), 8, '0');
end;
$$;

alter table public.vocabulary_items
  add column if not exists sentence_key text;

update public.vocabulary_items
set sentence_key = public.soda_sentence_key(sentence)
where sentence_key is null or sentence_key = '';

delete from public.vocabulary_items older
using public.vocabulary_items newer
where older.user_id = newer.user_id
  and older.content_hash = newer.content_hash
  and older.normalized_word = newer.normalized_word
  and older.sentence_key = newer.sentence_key
  and (
    older.created_at < newer.created_at
    or (older.created_at = newer.created_at and older.id::text > newer.id::text)
  );

alter table public.vocabulary_items
  alter column sentence_key set default '';

alter table public.vocabulary_items
  alter column sentence_key set not null;

alter table public.vocabulary_items
  drop constraint if exists vocabulary_items_user_id_content_hash_normalized_word_key;

alter table public.vocabulary_items
  drop constraint if exists vocabulary_items_context_key;

alter table public.vocabulary_items
  add constraint vocabulary_items_context_key
  unique (user_id, content_hash, normalized_word, sentence_key);
