
import { createClient } from "@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function makeScheduleKey(
  date: string,
  startTime: string,
  endTime: string,
): string {
  return `${date}|${startTime}|${endTime}`;
}

function formatDate(dateString: string): string {
  const date = new Date(`${dateString}T00:00:00`);
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  }).format(date);
}

function formatTime(timeString: string): string {
  return timeString.slice(0, 5);
}

async function sendEmail(params: {
  to_email: string;
  member_name: string;
  group_name: string;
  meeting_date: string;
  meeting_time: string;
  meeting_url: string;
}) {
  const response = await fetch(
    "https://api.emailjs.com/api/v1.0/email/send",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: requiredEnv("EMAILJS_SERVICE_ID"),
        template_id: requiredEnv("EMAILJS_TEMPLATE_ID"),
        user_id: requiredEnv("EMAILJS_PUBLIC_KEY"),
        accessToken: requiredEnv("EMAILJS_PRIVATE_KEY"),
        template_params: params,
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `EmailJS returned HTTP ${response.status}: ${errorText.slice(0, 500)}`,
    );
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

    // Server-only client. Never expose this key in browser JavaScript.
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Validate the actual Supabase Auth access token.
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Missing access token" }, 401);
    }

    const accessToken = authorization.slice("Bearer ".length).trim();
    const {
      data: { user },
      error: authError,
    } = await supabaseAdmin.auth.getUser(accessToken);

    if (authError || !user) {
      return jsonResponse({ error: "Invalid or expired session" }, 401);
    }

    const body = await req.json().catch(() => null);
    const meetingId = body?.meetingId;

    if (
      typeof meetingId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(meetingId)
    ) {
      return jsonResponse({ error: "A valid meetingId is required" }, 400);
    }

    // Load the meeting.
    const { data: meeting, error: meetingError } = await supabaseAdmin
      .from("meetings")
      .select(
        "id, group_id, meeting_date, start_time, end_time, created_by",
      )
      .eq("id", meetingId)
      .maybeSingle();

    if (meetingError) {
      console.error("Meeting query failed:", meetingError.message);
      return jsonResponse({ error: "Could not load meeting" }, 500);
    }

    if (!meeting) {
      return jsonResponse({ error: "Meeting not found" }, 404);
    }

    // Confirm that this user is an owner of this specific group.
    const { data: membership, error: membershipError } =
      await supabaseAdmin
        .from("group_members")
        .select("id")
        .eq("group_id", meeting.group_id)
        .eq("user_id", user.id)
        .eq("role", "owner")
        .maybeSingle();

    if (membershipError) {
      console.error("Membership query failed:", membershipError.message);
      return jsonResponse({ error: "Could not verify group ownership" }, 500);
    }

    if (!membership) {
      return jsonResponse(
        { error: "Only the group owner can send meeting notifications" },
        403,
      );
    }

    // Load group name.
    const { data: group, error: groupError } = await supabaseAdmin
      .from("groups")
      .select("id, name")
      .eq("id", meeting.group_id)
      .maybeSingle();

    if (groupError) {
      console.error("Group query failed:", groupError.message);
      return jsonResponse({ error: "Could not load group" }, 500);
    }

    if (!group) {
      return jsonResponse({ error: "Group not found" }, 404);
    }

    // Build a key from the confirmed schedule.
    const scheduleKey = makeScheduleKey(
      meeting.meeting_date,
      meeting.start_time,
      meeting.end_time,
    );

    // Claim this meeting schedule before sending any emails.
    const { data: notification, error: insertError } = await supabaseAdmin
      .from("meeting_email_notifications")
      .insert({
        meeting_id: meeting.id,
        schedule_key: scheduleKey,
        status: "sending",
        recipient_count: 0,
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        const { data: existing } = await supabaseAdmin
          .from("meeting_email_notifications")
          .select("status")
          .eq("meeting_id", meeting.id)
          .eq("schedule_key", scheduleKey)
          .maybeSingle();

        if (existing?.status === "sent") {
          return jsonResponse({
            ok: true,
            message: "This schedule has already been notified",
            alreadySent: true,
          });
        }

        if (existing?.status === "sending") {
          return jsonResponse({
            ok: true,
            message: "Notification is already being processed",
            alreadySending: true,
          }, 409);
        }

        // Retry a previously failed notification.
        if (existing?.status === "failed") {
          const { data: retryRecord, error: retryError } =
            await supabaseAdmin
              .from("meeting_email_notifications")
              .update({
                status: "sending",
                recipient_count: 0,
                error_message: null,
                updated_at: new Date().toISOString(),
              })
              .eq("meeting_id", meeting.id)
              .eq("schedule_key", scheduleKey)
              .eq("status", "failed")
              .select("id")
              .maybeSingle();

          if (retryError || !retryRecord) {
            return jsonResponse({
              error: "Could not claim failed notification for retry",
            }, 409);
          }

          // Continue below using the existing record.
          const retryResult = await deliverEmails(
            supabaseAdmin,
            retryRecord.id,
            meeting,
            group,
            scheduleKey,
          );
          return jsonResponse(retryResult.body, retryResult.status);
        }
      }

      console.error("Notification insert failed:", insertError.message);
      return jsonResponse({ error: "Could not start email notification" }, 500);
    }

    const result = await deliverEmails(
      supabaseAdmin,
      notification.id,
      meeting,
      group,
      scheduleKey,
    );

    return jsonResponse(result.body, result.status);
  } catch (error) {
    console.error(
      "notify-meeting-confirmed error:",
      error instanceof Error ? error.message : error,
    );

    return jsonResponse({ error: "Internal server error" }, 500);
  }
});

async function deliverEmails(
  supabaseAdmin: ReturnType<typeof createClient>,
  notificationId: string,
  meeting: {
    id: string;
    group_id: string;
    meeting_date: string;
    start_time: string;
    end_time: string;
  },
  group: { id: string; name: string },
  _scheduleKey: string,
): Promise<{ body: Record<string, unknown>; status: number }> {
  try {
    const { data: members, error: membersError } = await supabaseAdmin
      .from("group_members")
      .select("user_id")
      .eq("group_id", group.id);

    if (membersError) throw membersError;

    const memberIds = [
      ...new Set((members ?? []).map((member) => member.user_id)),
    ];

    if (memberIds.length === 0) {
      throw new Error("This group has no members");
    }

    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, email")
      .in("id", memberIds);

    if (profilesError) throw profilesError;

    const recipients = (profiles ?? []).filter(
      (profile) =>
        typeof profile.email === "string" &&
        profile.email.trim().length > 0,
    );

    if (recipients.length === 0) {
      throw new Error("No group members have an email address");
    }

    const siteUrl = requiredEnv("SITE_URL").replace(/\/+$/, "");
    const meetingUrl =
      `${siteUrl}/meeting-details.html?id=${encodeURIComponent(meeting.id)}`;

    const meetingDate = formatDate(meeting.meeting_date);
    const meetingTime =
      `${formatTime(meeting.start_time)} - ${formatTime(meeting.end_time)}`;

    const failures: string[] = [];
    let sentCount = 0;

    // EmailJS rate limit: one request per second.
    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];

      try {
        await sendEmail({
          to_email: recipient.email.trim(),
          member_name: recipient.full_name || "สมาชิก TimeMatch",
          group_name: group.name,
          meeting_date: meetingDate,
          meeting_time: meetingTime,
          meeting_url: meetingUrl,
        });

        sentCount++;
      } catch (error) {
        console.error(
          `Email failed for recipient ${recipient.id}:`,
          error instanceof Error ? error.message : error,
        );
        failures.push(recipient.id);
      }

      if (i < recipients.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
    }

    if (failures.length > 0) {
      const errorMessage =
        `${sentCount} sent; ${failures.length} failed. ` +
        `Failed profile IDs: ${failures.join(", ")}`;

      await supabaseAdmin
        .from("meeting_email_notifications")
        .update({
          status: "failed",
          recipient_count: sentCount,
          error_message: errorMessage.slice(0, 2000),
          updated_at: new Date().toISOString(),
        })
        .eq("id", notificationId);

      return {
        status: 502,
        body: {
          ok: false,
          message: "Some emails could not be sent",
          sentCount,
          failedCount: failures.length,
        },
      };
    }

    const { error: updateError } = await supabaseAdmin
      .from("meeting_email_notifications")
      .update({
        status: "sent",
        recipient_count: sentCount,
        sent_at: new Date().toISOString(),
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", notificationId);

    if (updateError) {
      // Emails have already been sent. Do not automatically send them again.
      console.error("Could not update notification status:", updateError.message);
      return {
        status: 500,
        body: {
          ok: false,
          message: "Emails were sent, but notification status could not be saved",
          sentCount,
        },
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        message: "Meeting notification emails sent",
        recipientCount: sentCount,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await supabaseAdmin
      .from("meeting_email_notifications")
      .update({
        status: "failed",
        error_message: message.slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq("id", notificationId);

    console.error("Email delivery failed:", message);

    return {
      status: 500,
      body: { error: "Email notification failed" },
    };
  }
}
