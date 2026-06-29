import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { burnStringsOntoImage } from './canvas.js';

const SUPABASE_URL = 'https://ahuqkfkwdxvtvtsvitam.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFodXFrZmt3ZHh2dHZ0c3ZpdGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NDI4MzcsImV4cCI6MjA5NjUxODgzN30.wbTGw2MUV6vvsPNKM3SVGgDE-6aOzqLx28l5hxa3iWE';
const BUCKET = 'photos';
const INVITE_KEY = 'LSINC-Photos@2026';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export function validateInviteKey(key) {
  return key.trim() === INVITE_KEY;
}

function dataUrlToBlob(dataUrl) {
  const [header, data] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(data);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function uploadImage(dataUrl, path) {
  const blob = dataUrlToBlob(dataUrl);
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  // Cache-bust so browsers always show the latest image after an update
  return data.publicUrl + '?t=' + Date.now();
}

// ── Parts ──────────────────────────────────────────────────────────────────

export async function getAllParts() {
  const [{ data: parts, error: pe }, { data: photos, error: phe }] = await Promise.all([
    supabase.from('parts').select('*').order('created_at', { ascending: false }),
    supabase.from('part_photos').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
  ]);
  if (pe) throw pe;
  if (phe) throw phe;
  return parts.map(part => ({
    ...part,
    photos: photos.filter(p => p.part_id === part.id),
  }));
}

export async function findPartIdByNumber(part_number) {
  const { data, error } = await supabase
    .from('parts')
    .select('id')
    .eq('part_number', part_number)
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0].id : null;
}

export async function createPart({ part_number, description, printers }) {
  const { data, error } = await supabase
    .from('parts')
    .insert({ part_number, description: description || '', printers: printers || [] })
    .select().single();
  if (error) throw error;
  return data;
}

export async function updatePart(partId, updates) {
  const { data, error } = await supabase
    .from('parts')
    .update(updates)
    .eq('id', partId)
    .select().single();
  if (error) throw error;
  return data;
}

export async function deletePart(partId) {
  const { data: photos } = await supabase.from('part_photos').select('id').eq('part_id', partId);
  if (photos?.length) {
    const paths = photos.flatMap(p => [
      `parts/${partId}/${p.id}/burned.jpg`,
      `parts/${partId}/${p.id}/original.jpg`,
    ]);
    await supabase.storage.from(BUCKET).remove(paths);
  }
  const { error } = await supabase.from('parts').delete().eq('id', partId);
  if (error) throw error;
}

// ── Part Photos ────────────────────────────────────────────────────────────

export async function addPhotoToPart(partId, partNumber, { imageDataUrl, machine_label, position }) {
  const strings = [partNumber];
  if (machine_label?.trim()) strings.push(machine_label.trim());
  const burned = await burnStringsOntoImage(imageDataUrl, strings, { position });

  const photoId = crypto.randomUUID();
  const [burnedUrl, originalUrl] = await Promise.all([
    uploadImage(burned, `parts/${partId}/${photoId}/burned.jpg`),
    uploadImage(imageDataUrl, `parts/${partId}/${photoId}/original.jpg`),
  ]);

  const { data, error } = await supabase
    .from('part_photos')
    .insert({
      id: photoId,
      part_id: partId,
      image_url: burnedUrl,
      original_url: originalUrl,
      machine_label: machine_label || '',
      position,
    })
    .select().single();
  if (error) throw error;
  return data;
}

// ── Auth ───────────────────────────────────────────────────────────────────


export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export async function isEmailApproved(email) {
  const { data } = await supabase
    .from('approved_emails')
    .select('email, status')
    .eq('email', email)
    .maybeSingle();
  return data?.status === 'approved';
}

export async function approveEmail(email) {
  const { error } = await supabase
    .from('approved_emails')
    .insert({ email, status: 'approved' });
  if (error && error.code !== '23505') throw error; // ignore duplicate
}

export async function signInWithEmail(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function requestEmailAccess(email, password) {
  // Create the auth account
  const { error: signUpError } = await supabase.auth.signUp({ email, password });
  if (signUpError && !signUpError.message.includes('already registered')) throw signUpError;

  // Insert as pending — admin must change status to 'approved' in Supabase
  const { error: insertError } = await supabase
    .from('approved_emails')
    .insert({ email, status: 'pending' });
  if (insertError && insertError.code !== '23505') throw insertError;

  // Sign back out — they shouldn't have access until approved
  await supabase.auth.signOut();
}

export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange(callback);
}

// ── Shared app config (catalog URL, Claude API key, model, prices) ───────────
// Stored in an "app_config" table so every device shares one setup. Returns null
// if the table is missing or unreadable, so callers can fall back to local storage.
export async function getAppConfig() {
  const { data, error } = await supabase
    .from('app_config')
    .select('data')
    .eq('id', 'default')
    .maybeSingle();
  if (error) return null;
  return (data && data.data) || {};
}

export async function saveAppConfig(patch) {
  const current = (await getAppConfig()) || {};
  const merged = { ...current, ...patch };
  const { error } = await supabase
    .from('app_config')
    .upsert({ id: 'default', data: merged, updated_at: new Date().toISOString() });
  if (error) throw error;
  return merged;
}

export async function updatePartPhoto(photoId, partId, partNumber, { imageDataUrl, machine_label, position }) {
  const strings = [partNumber];
  if (machine_label?.trim()) strings.push(machine_label.trim());
  const burned = await burnStringsOntoImage(imageDataUrl, strings, { position });
  const [burnedUrl, originalUrl] = await Promise.all([
    uploadImage(burned, `parts/${partId}/${photoId}/burned.jpg`),
    uploadImage(imageDataUrl, `parts/${partId}/${photoId}/original.jpg`),
  ]);
  const { error } = await supabase
    .from('part_photos')
    .update({ image_url: burnedUrl, original_url: originalUrl, machine_label: machine_label || '', position })
    .eq('id', photoId);
  if (error) throw error;
}

export async function reorderPhotos(orderedPhotoIds) {
  await Promise.all(
    orderedPhotoIds.map((id, index) =>
      supabase.from('part_photos').update({ sort_order: index }).eq('id', id)
    )
  );
}

export async function deletePartPhoto(photoId, partId) {
  await supabase.storage.from(BUCKET).remove([
    `parts/${partId}/${photoId}/burned.jpg`,
    `parts/${partId}/${photoId}/original.jpg`,
  ]);
  const { error } = await supabase.from('part_photos').delete().eq('id', photoId);
  if (error) throw error;
}
