import express from 'express';
import cron from 'node-cron';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config({ override: true });

const app = express();
app.use(cors());
app.use(express.json());



// Constants
const DEFAULT_CATEGORIES = [
  'All',
  'Technology',
  'Business',
  'Politics',
  'Sports',
  'Entertainment',
  'Science',
  'Health',
  'World News'
];

const TIME_SLOTS = [
  { value: 'night', label: 'Night', time: '12 AM - 6 AM', hours: [0, 1, 2, 3, 4, 5], cronTime: '0 0 * * *' }, // 12 AM (midnight)
  { value: 'morning', label: 'Morning', time: '6 AM - 10 AM', hours: [6, 7, 8, 9], cronTime: '0 6 * * *' }, // 6 AM
  { value: 'noon', label: 'Noon', time: '10 AM - 2 PM', hours: [10, 11, 12, 13], cronTime: '0 10 * * *' }, // 10 AM
  { value: 'afternoon', label: 'Afternoon', time: '2 PM - 6 PM', hours: [14, 15, 16, 17], cronTime: '0 14 * * *' }, // 2 PM
  { value: 'evening', label: 'Evening', time: '6 PM - 12 AM', hours: [18, 19, 20, 21, 22, 23], cronTime: '0 18 * * *' } // 6 PM
];


// === Authentication & Email Imports ===
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

// === Initialize Supabase Admin Client ===
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// === Initialize Resend ===
const resend = new Resend(process.env.RESEND_API_KEY);

console.log('✓ Supabase Admin Client Initialized');
console.log('✓ Resend Email Service Initialized');



// Function to get today's date in YYYY-MM-DD format (UAE timezone)
function getTodayDate() {
  const now = new Date();
  const uaeDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
  return uaeDate.toISOString().split('T')[0];
}

// Function to generate news using Claude API (with retry on 429)
async function generateNews(category, day, timeSlot, retries = 3) {
  const categoryQuery = category === 'All' ? 'top news' : category;
  const dayInfo = day === getTodayDate() ? 'today' : `on ${day}`;

  console.log(`Generating news for ${category} on ${day} at ${timeSlot}`);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: `Search the web for recent news about "${categoryQuery}" from ${dayInfo} during ${timeSlot.toLowerCase()}. Create a comprehensive, well-structured news summary with the most important stories, key developments, and notable events. Format with clear sections and headlines. Make it informative and engaging. IMPORTANT: Complete all sentences - do not cut off mid-sentence.`
      }],
      tools: [{ type: "web_search_20250305", name: "web_search" }]
    })
  });

  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '65', 10);
    console.log(`⏳ Rate limited. Waiting ${retryAfter}s before retry (${retries} retries left)...`);
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    return generateNews(category, day, timeSlot, retries - 1);
  }

  if (!response.ok) {
    const errData = await response.json();
    throw new Error(`Claude API error: ${response.status} - ${JSON.stringify(errData)}`);
  }

  const data = await response.json();
  const summary = data.content
    .filter(item => item.type === "text")
    .map(item => item.text)
    .join("\n");

  return summary;
}

// Function to store news in Supabase
async function storeNews(category, day, timeSlot, content) {
  try {
    const generated_at = new Date().toISOString();

    const { data: existing } = await supabaseAdmin
      .from('news_summaries')
      .select('id')
      .eq('category', category)
      .eq('day', day)
      .eq('time_slot', timeSlot)
      .maybeSingle();

    let error;
    if (existing) {
      ({ error } = await supabaseAdmin
        .from('news_summaries')
        .update({ content, generated_at })
        .eq('id', existing.id));
    } else {
      ({ error } = await supabaseAdmin
        .from('news_summaries')
        .insert({ category, day, time_slot: timeSlot, content, generated_at }));
    }

    if (error) throw new Error(`Supabase error: ${error.message}`);

    console.log(`✅ Stored news for ${category} on ${day} at ${timeSlot}`);
  } catch (error) {
    console.error(`Error storing news in Supabase:`, error);
    throw error;
  }
}

// Function to generate all news for a time slot
async function generateAllNewsForTimeSlot(timeSlot) {
  console.log(`\n🚀 Starting news generation for ${timeSlot} time slot...`);
  const today = getTodayDate();
  
  for (const category of DEFAULT_CATEGORIES) {
    try {
      const content = await generateNews(category, today, timeSlot);
      await storeNews(category, today, timeSlot, content);
      
      // Delay between API calls to stay within rate limits (30k tokens/min)
      await new Promise(resolve => setTimeout(resolve, 15000));
    } catch (error) {
      console.error(`Failed to generate/store news for ${category}:`, error.message);
      // Continue with next category even if one fails
    }
  }
  
  console.log(`✨ Completed news generation for ${timeSlot} time slot\n`);
}

// Cloud Scheduler will trigger the /api/generate/:timeSlot endpoints
// No local cron jobs needed on Cloud Run

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


// Generate news for a single custom category
app.post('/api/generate/custom-category', async (req, res) => {
  try {
    const { category, day, timeSlot } = req.body;

    if (!category || !day || !timeSlot) {
      return res.status(400).json({ error: 'category, day and timeSlot are required' });
    }

    console.log(`🔧 Generating custom category: ${category} / ${day} / ${timeSlot}`);

    const newsContent = await generateNews(category, day, timeSlot);

    const { error } = await supabaseAdmin
  .from('news_summaries')
  .upsert({
    user_id: req.body.user_id,
    category: category,
    day: day,
    time_slot: timeSlot,
    content: newsContent,
    generated_at: new Date().toISOString()
  }, {
    onConflict: 'user_id,category,day,time_slot'
  });

    if (error) {
      console.error('Failed to save custom category news:', error);
      return res.status(500).json({ error: 'Failed to save news', details: error.message });
    }

    console.log(`✓ Custom category news saved: ${category}`);
    res.json({ success: true, category, day, timeSlot });

  } catch (error) {
    console.error('Custom category generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manual trigger endpoint for testing
app.post('/api/generate/:timeSlot', async (req, res) => {
  try {
    const timeSlot = req.params.timeSlot;
    const slot = TIME_SLOTS.find(s => s.label.toLowerCase() === timeSlot.toLowerCase());
    
    if (!slot) {
      return res.status(400).json({ error: 'Invalid time slot' });
    }

    await generateAllNewsForTimeSlot(slot.label);
    
    res.json({ 
      status: 'success', 
      message: `Generated all news for ${slot.label}`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Endpoint to get news from Supabase
app.get('/api/news/:category/:day/:timeSlot', async (req, res) => {
  try {
    const { category, day, timeSlot } = req.params;
    
    const { data, error } = await supabaseAdmin
      .from('news_summaries')
      .select('*')
      .eq('category', category)
      .eq('day', day)
      .eq('time_slot', timeSlot)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    if (!data) {
      return res.status(404).json({ 
        error: 'News not found',
        message: 'This news summary has not been generated yet'
      });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to get all news for a day
app.get('/api/news/day/:day', async (req, res) => {
  try {
    const { day } = req.params;
    
    const { data, error } = await supabaseAdmin
      .from('news_summaries')
      .select('*')
      .eq('day', day);

    if (error) {
      throw error;
    }

    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ENDPOINT 1: SEND VERIFICATION EMAIL
// ==========================================
app.post('/api/auth/send-verification', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ 
        error: 'Email and password are required' 
      });
    }

    console.log(`📧 Processing sign-up for ${email}`);

    // === CHECK IF USER ALREADY EXISTS ===
    const { data: existingUser, error: checkError } = await supabaseAdmin
      .from('users')
      .select('id, verification_status')
      .eq('email', email)
      .single();

    let userId;

    if (existingUser) {
      console.log('✓ User already exists:', existingUser.id);
      userId = existingUser.id;
      
      if (existingUser.verification_status === 'verified') {
        return res.status(400).json({ 
          error: 'This email is already verified. Please sign in instead.' 
        });
      }
    } else {
      // === CREATE USER IN SUPABASE AUTH ===
      console.log('Creating new Auth user...');
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: email,
        password: password,
        email_confirm: false
      });

      if (authError) {
        if (authError.message.includes('already been registered')) {
          // User exists in Auth but not in users table
          const { data: authUsers, error: listError } = await supabaseAdmin.auth.admin.listUsers();
          if (!listError) {
            const foundUser = authUsers.users.find(u => u.email === email);
            if (foundUser) {
              userId = foundUser.id;
              console.log('✓ Found existing Auth user:', userId);
              
              // Create profile if it doesn't exist
              const { error: insertError } = await supabaseAdmin
                .from('users')
                .insert({
                  id: userId,
                  email: email,
                  verification_status: 'pending'
                });
              
              if (insertError && !insertError.message.includes('duplicate')) {
                console.error('Profile creation failed:', insertError);
              }
            }
          }
        } else {
          console.error('Auth creation failed:', authError);
          return res.status(500).json({ 
            error: 'Failed to create account',
            details: authError.message 
          });
        }
      } else {
        userId = authData.user.id;
        console.log('✓ User created in Auth:', userId);

        // === CREATE USER PROFILE ===
        const { error: profileError } = await supabaseAdmin
          .from('users')
          .insert({
            id: userId,
            email: email,
            verification_status: 'pending'
          });

        if (profileError) {
          console.error('Profile creation failed:', profileError);
          return res.status(500).json({ 
            error: 'Failed to create user profile',
            details: profileError.message 
          });
        }
        console.log('✓ User profile created');
      }
    }

    // === GENERATE TOKEN ===
    const verificationToken = Math.random().toString(36).substring(2, 15) + 
                              Math.random().toString(36).substring(2, 15);
    
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    const { error: tokenError } = await supabaseAdmin
      .from('users')
      .update({
        verification_token: verificationToken,
        verification_token_expires_at: expiresAt.toISOString()
      })
      .eq('id', userId);

    if (tokenError) {
      console.error('Token storage failed:', tokenError);
      return res.status(500).json({ 
        error: 'Failed to create verification token',
        details: tokenError.message 
      });
    }

    console.log('✓ Token generated');

    // === SEND EMAIL ===
    const verificationLink = `http://localhost:3000/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}`;
    
    const result = await resend.emails.send({
      from: 'noreply@resend.dev',
      to: email,
      subject: 'Verify your email - The AI Rundown',
      html: `
        <h2>Welcome to The AI Rundown!</h2>
        <p>Click the link below to verify your email and complete your sign-up:</p>
        <a href="${verificationLink}" style="padding: 10px 20px; background: #6366f1; color: white; text-decoration: none; border-radius: 5px; display: inline-block;">
          Verify Email
        </a>
        <p>Or copy this link: <br>${verificationLink}</p>
        <p>This link expires in 24 hours.</p>
      `
    });

    if (result.error) {
      console.error('Email send failed:', result.error);
      return res.status(500).json({ 
        error: 'Failed to send verification email',
        details: result.error.message 
      });
    }

    console.log('✓ Verification email sent');

    res.json({ 
      success: true, 
      message: 'Verification email sent',
      userId: userId
    });

  } catch (error) {
    console.error('Sign-up endpoint error:', error);
    res.status(500).json({ 
      error: 'Failed during sign-up',
      details: error.message 
    });
  }
});



// ==========================================
// ENDPOINT 2: VERIFY EMAIL TOKEN
// ==========================================
app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { token, email } = req.body;

    if (!token || !email) {
      return res.status(400).json({ 
        error: 'Token and email are required' 
      });
    }

    console.log(`🔐 Verifying email token for ${email}`);

    // Find user with this token
    const { data: user, error: findError } = await supabaseAdmin
      .from('users')
      .select('id, verification_token, verification_token_expires_at')
      .eq('email', email)
      .single();

    if (findError || !user) {
      console.error('User not found:', findError);
      return res.status(401).json({ 
        error: 'Invalid email or token' 
      });
    }

    // Check if token matches
    if (user.verification_token !== token) {
      console.error('Token mismatch');
      return res.status(401).json({ 
        error: 'Invalid verification token' 
      });
    }

    // Check if token expired
    const now = new Date();
    const expiresAt = new Date(user.verification_token_expires_at);
    
    if (now > expiresAt) {
      console.error('Token expired');
      return res.status(401).json({ 
        error: 'Verification link expired',
        code: 'TOKEN_EXPIRED'
      });
    }

    console.log(`✓ Token verified for user ${user.id}`);

    // Update user's verification status
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        verification_status: 'verified',
        email_verified_at: new Date().toISOString(),
        verification_token: null,
        verification_token_expires_at: null
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('Database update failed:', updateError);
      return res.status(500).json({ error: 'Failed to verify email' });
    }

    console.log(`✓ User ${user.id} marked as verified`);

    // Track metric
    try {
      await supabaseAdmin
        .from('behavioral_metrics')
        .insert({
          user_id: user.id,
          event_type: 'email_verified',
          metadata: { email },
          created_at: new Date().toISOString()
        });
    } catch (err) {
      console.warn('Could not track metric:', err.message);
    }

    res.json({ 
      success: true, 
      message: 'Email verified successfully',
      userId: user.id
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});



// ==========================================
// ENDPOINT 3: RESEND VERIFICATION EMAIL
// ==========================================
app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const { email, userId } = req.body;

    if (!email || !userId) {
      return res.status(400).json({ 
        error: 'Email and userId are required' 
      });
    }

    console.log(`🔄 Resending verification email to ${email}`);

    // Check if already verified
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('verification_status')
      .eq('id', userId)
      .single();

    if (user?.verification_status === 'verified') {
      return res.status(400).json({ 
        error: 'Email already verified'
      });
    }

    // Generate new token
    const verificationToken = Math.random().toString(36).substring(2, 15) + 
                              Math.random().toString(36).substring(2, 15);
    
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    // Store token
    const { error: tokenError } = await supabaseAdmin
      .from('users')
      .update({
        verification_token: verificationToken,
        verification_token_expires_at: expiresAt.toISOString()
      })
      .eq('id', userId);

    if (tokenError) {
      return res.status(500).json({ 
        error: 'Failed to generate verification token' 
      });
    }

    // Build link and send email
    const verificationLink = `${process.env.REACT_APP_URL}/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}`;

    const { error: emailError } = await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to: email,
      subject: '✨ Verify Your Email - The AI Rundown (Resend)',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #f5f7fa;">
          <div style="background: white; padding: 40px; border-radius: 12px;">
            <h2 style="color: #6366f1; margin-top: 0;">Verification Email Resent</h2>
            <p style="color: #64748b;">Here's your verification link (valid for 24 hours):</p>
            <div style="margin: 30px 0;">
              <a href="${verificationLink}" style="background: linear-gradient(135deg, #6366f1 0%, #ec4899 100%); color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
                Verify Email
              </a>
            </div>
          </div>
        </div>
      `
    });

    if (emailError) {
      return res.status(500).json({ 
        error: 'Failed to send email' 
      });
    }

    console.log(`✓ Resend verification email sent to ${email}`);

    res.json({ 
      success: true, 
      message: 'Verification email resent successfully' 
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ENDPOINT 4: TRACK BEHAVIORAL METRICS
// ==========================================
app.post('/api/metrics/track', async (req, res) => {
  try {
    const { 
      userId, 
      eventType, 
      pageName, 
      category, 
      day, 
      time, 
      duration_seconds,
      metadata 
    } = req.body;

    if (!userId || !eventType) {
      return res.status(400).json({ 
        error: 'userId and eventType are required' 
      });
    }

    console.log(`📊 Tracking event: ${eventType} for user ${userId.substring(0, 8)}...`);

    // Insert metric
    const { error } = await supabaseAdmin
      .from('behavioral_metrics')
      .insert({
        user_id: userId,
        event_type: eventType,
        page_name: pageName || null,
        category_selected: category || null,
        day_selected: day || null,
        time_selected: time || null,
        duration_seconds: duration_seconds || null,
        metadata: metadata || null,
        created_at: new Date().toISOString()
      });

    if (error) {
      console.error('Metric tracking failed:', error);
      return res.status(500).json({ 
        error: 'Failed to track metric' 
      });
    }

    console.log(`✓ Event tracked: ${eventType}`);

    res.json({ 
      success: true,
      message: 'Metric tracked'
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎉 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`⏰ Timezone: Asia/Dubai (UAE)\n`);
  console.log('📅 Scheduled cron jobs:');
  TIME_SLOTS.forEach(slot => {
    console.log(`   - ${slot.label}: ${slot.cronTime}`);
  });
  console.log('\n');
});