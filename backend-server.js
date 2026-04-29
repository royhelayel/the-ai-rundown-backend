import express from 'express';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import cors from 'cors';
import dotenv from 'dotenv';
 
dotenv.config();
 
const app = express();
app.use(cors());
app.use(express.json());
 
// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
 
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
 
// Function to get today's date in YYYY-MM-DD format (UAE timezone)
function getTodayDate() {
  const now = new Date();
  const uaeDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
  return uaeDate.toISOString().split('T')[0];
}
 
// Function to generate news using Claude API
async function generateNews(category, day, timeSlot) {
  try {
    console.log(`Generating news for ${category} on ${day} at ${timeSlot}`);
    
    const categoryQuery = category === 'All' ? 'top news' : category;
    const dayInfo = day === getTodayDate() ? 'today' : `on ${day}`;
    
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2500,
        messages: [{
          role: "user",
          content: `Search the web for recent news about "${categoryQuery}" from ${dayInfo} during ${timeSlot.toLowerCase()}. Create a comprehensive, well-structured news summary with the most important stories, key developments, and notable events. Format with clear sections and headlines. Make it informative and engaging. IMPORTANT: Complete all sentences - do not cut off mid-sentence.`
        }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search"
          }
        ]
      })
    });
 
    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }
 
    const data = await response.json();
    const summary = data.content
      .filter(item => item.type === "text")
      .map(item => item.text)
      .join("\n");
 
    return summary;
  } catch (error) {
    console.error(`Error generating news for ${category}:`, error);
    throw error;
  }
}
 
// Function to store news in Supabase
async function storeNews(category, day, timeSlot, content) {
  try {
    const { data, error } = await supabase
      .from('news_summaries')
      .upsert({
        category,
        day,
        time_slot: timeSlot,
        content,
        generated_at: new Date().toISOString()
      }, {
        onConflict: 'category,day,time_slot'
      });
 
    if (error) {
      throw new Error(`Supabase error: ${error.message}`);
    }
 
    console.log(`✅ Stored news for ${category} on ${day} at ${timeSlot}`);
    return data;
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
      
      // Small delay between API calls to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`Failed to generate/store news for ${category}:`, error.message);
      // Continue with next category even if one fails
    }
  }
  
  console.log(`✨ Completed news generation for ${timeSlot} time slot\n`);
}
 
// Setup cron jobs for each time slot
TIME_SLOTS.forEach(slot => {
  console.log(`📅 Scheduling cron job for ${slot.label} at ${slot.cronTime} (UAE timezone)`);
  
  cron.schedule(slot.cronTime, () => {
    generateAllNewsForTimeSlot(slot.label);
  }, {
    timezone: "Asia/Dubai"
  });
});
 
// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
    
    const { data, error } = await supabase
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
    
    const { data, error } = await supabase
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
