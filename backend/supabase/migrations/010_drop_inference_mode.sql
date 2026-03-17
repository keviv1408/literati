-- Migration 010: Remove the deprecated inference_mode room setting

ALTER TABLE public.rooms
  DROP COLUMN IF EXISTS inference_mode;
