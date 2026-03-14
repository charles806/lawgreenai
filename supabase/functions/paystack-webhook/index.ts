import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import * as crypto from 'https://deno.land/std@0.168.0/node/crypto.ts';

const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY') || '';
const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''; // Must use service role to bypass RLS

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const planMapping: Record<string, string> = {
  // map Paystack plan codes or amounts to your DB plan IDs if needed
  // or default to parsing from reference metadata
};

serve(async (req: Request) => {
  // Ensure it's a POST request
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const signature = req.headers.get('x-paystack-signature');
  const bodyText = await req.text();
  
  let payload: any;
  try {
    payload = JSON.parse(bodyText);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  // 1. Verify Webhook Signature (If incoming from Paystack natively)
  if (signature) {
    const hash = crypto.createHmac('sha512', paystackSecretKey).update(bodyText).digest('hex');
    if (hash !== signature) {
      return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 403 });
    }
  }

  const event = payload.event;
  const data = payload.data;

  // We handle both native webhook (charge.success) and client invocation (client_activation)
  if (event === 'charge.success' || event === 'client_activation') {
    const reference = data.reference;
    const email = data.customer?.email;

    if (!reference || !email) {
      return new Response(JSON.stringify({ error: 'Missing reference or email' }), { status: 400 });
    }

    try {
      // 2. Verify Transaction with Paystack API
      const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
        },
      });

      const verifyData = await verifyRes.json();

      if (!verifyData.status || verifyData.data.status !== 'success') {
         return new Response(JSON.stringify({ error: 'Transaction verification failed' }), { status: 400 });
      }

      // Optional: Verify amount paid matches the expected plan amount

      // 3. Find User by Email
      const { data: userData, error: userError } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('email', email)
        .single();

      if (userError || !userData) {
        return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });
      }

      // 4. Update User Profile with Edge Function (Bypasses RLS utilizing Service Role)
      // We calculate a 30-day expiration date
      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + 30); // Add 30 days

      // If the client sent a plan, use it, else default to 'essential' or derive from amount
      const plan = payload.data.plan || 'essential'; 

      const { error: updateError } = await supabase
        .from('user_profiles')
        .update({
          subscription_plan: plan,
          subscription_status: 'active',
          payment_reference: reference,
          subscription_expires_at: expirationDate.toISOString(), // Assuming you add this column
          updated_at: new Date().toISOString(),
        })
        .eq('id', userData.id);

      if (updateError) {
        console.error('DB Update Error:', updateError);
        return new Response(JSON.stringify({ error: 'Failed to update database' }), { status: 500 });
      }

      return new Response(JSON.stringify({ message: 'Success' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (err) {
      console.error('Verification error:', err);
      return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
    }
  }

  // Acknowledge other events to prevent retries
  return new Response(JSON.stringify({ message: 'Event ignored' }), { status: 200 });
})
