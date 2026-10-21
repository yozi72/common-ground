export default function Privacy() {
  return (
    <article className="prose-sm space-y-4 max-w-none">
      <h1 className="text-2xl font-semibold">How Common Ground handles your information</h1>
      <section className="space-y-2">
        <h2 className="font-medium text-lg">Two kinds of anonymity</h2>
        <p>You are anonymous to the person you talk with: they see a random alias, never your email or account. You are not anonymous to the service: we need your email to sign you in, and we store your messages to deliver and review them.</p>
      </section>
      <section className="space-y-2">
        <h2 className="font-medium text-lg">Before a message is delivered</h2>
        <p>The AI that writes shared questions receives only: the conversation stage, the questions already asked or skipped, recent approved messages, and, if you both opted in, your coarse life-context tags. Every message is held and reviewed before the other person can see it. Review combines rule-based checks (for things like phone numbers and links) with, when configured, an AI review. Neither is perfect. If a message is held, you'll see why and can revise, cancel, or appeal. The other person never sees held content.</p>
      </section>
      <section className="space-y-2">
        <h2 className="font-medium text-lg">What we keep and for how long</h2>
        <ul className="list-disc pl-5">
          <li>Delivered messages in a session with a new person: deleted 30 days after that conversation ends.</li>
          <li>Delivered messages in a friend chat: each one is deleted 30 days after it was sent, even if the chat stays open.</li>
          <li>Held or blocked messages: deleted after 7 days (longer if under appeal).</li>
          <li>Reports: kept up to a year for safety review.</li>
          <li>Waiting-list entries: deleted 90 days after they end. Aggregate usage counters (joins, waits, deliveries; never message content or answers): kept up to a year.</li>
          <li>Your matching questionnaire answers and the issues you marked as mattering most: used only to pair you with someone who answered differently (we compare answers issue by issue; there is no left/right score or label). Only you can see them. They are never shown to another person, never included in notifications or analytics, and never sent to the AI that writes conversation questions.</li>
          <li>Deleting your account removes your account, profile, messages, and connections immediately.</li>
        </ul>
      </section>
      <section className="space-y-2">
        <h2 className="font-medium text-lg">Reconnecting</h2>
        <p>After a conversation, each of you can privately say whether you'd talk again. Only if both say yes do you both find out. Sharing contact details is not available in this pilot.</p>
      </section>
    </article>
  );
}
