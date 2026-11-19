import { redirect } from 'next/navigation';

/** Legacy invite URL — guests now join through /join/:token. */
export default function LegacyGuestRecordPage({ params }: { params: { token: string } }) {
  redirect(`/join/${params.token}`);
}
