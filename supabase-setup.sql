-- Create the news_summaries table
CREATE TABLE news_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(255) NOT NULL,
  day DATE NOT NULL,
  time_slot VARCHAR(50) NOT NULL,
  content TEXT NOT NULL,
  generated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(category, day, time_slot)
);

-- Create index for faster queries
CREATE INDEX idx_news_summaries_category_day_time 
ON news_summaries(category, day, time_slot);

-- Create index for fetching by day
CREATE INDEX idx_news_summaries_day 
ON news_summaries(day);

-- Enable RLS (Row Level Security)
ALTER TABLE news_summaries ENABLE ROW LEVEL SECURITY;

-- Create policy to allow public read access
CREATE POLICY "Enable read access for all users" 
ON news_summaries FOR SELECT 
USING (true);

-- Create policy to allow backend to write
CREATE POLICY "Enable insert for backend" 
ON news_summaries FOR INSERT 
WITH CHECK (true);

-- Create policy to allow backend to update
CREATE POLICY "Enable update for backend" 
ON news_summaries FOR UPDATE 
USING (true) 
WITH CHECK (true);
