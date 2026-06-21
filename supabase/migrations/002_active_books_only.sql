delete from public.reader_annotations annotation
using public.documents document
where annotation.user_id = document.user_id
  and annotation.document_id = document.id
  and document.deleted_at is not null;

delete from public.cards card
using public.documents document
where card.user_id = document.user_id
  and card.document_id = document.id
  and document.deleted_at is not null;

delete from public.reading_progress progress
using public.documents document
where progress.user_id = document.user_id
  and progress.document_id = document.id
  and document.deleted_at is not null;

delete from public.documents
where deleted_at is not null;

delete from public.cards card
where coalesce(card.document_id, '') <> ''
  and not exists (
    select 1
    from public.documents document
    where document.user_id = card.user_id
      and document.id = card.document_id
  );

alter table public.documents
drop column if exists deleted_at;
