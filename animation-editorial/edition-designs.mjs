// Each line is an editorial decision for this exact update, in publication order.
// Reusable vector objects are drawing vocabulary, not a semantic template selector.
export const designs = `
ball:Thunder;medical:injur|surgery
jersey:Caruso;medical:ankle|sprain
calendar:weeks;medical:knee|bruise
jersey:Jazz;scan:MRI|injur
ball:NBA;agreement:partnership
ball:season;ring:Knicks
jersey:players;bulb:breakout
ball:Ty Jerome;receipt:points
football:Kane;trophy:Ballon d'Or
trophy:Ballon d'Or;jersey:Alexia Putellas
football:World Cup|match;pause:abandoned
jersey:England;people:Litten|Knowles
jersey:Wales;stadium:clubs
ball:Harlequins;people:members
football:football;document:decisions|transparency
jersey:Manchester United;coin:compensation
football:striker;scan:radar
microphone:hosts|panel;football:Football
plane:Cape Town;jersey:Ulster
bank:trust bank;coin:stablecoin
bank:banks;document:GENIUS Act|compliance
document:rules;clock:60-day
coin:crypto;calendar:2029
wallet:payments;document:IPO
wallet:wallet;key:authentication key
chip:GPU;document:futures
document:IPO;bank:Nasdaq
ball:NBA;document:agreement
agreement:deal;document:contracts
coin:Ethereum;wallet:holdings|holding
server:websites;shield:patches
document:IPO;bank:Nasdaq
chip:AI;shield:safeguard|risks
server:cloud compute;document:commitments
factory:natural gas;server:data center
coin:fundraising;chip:AI
calendar:calendars;inbox:email
phone:devices;microphone:Siri
chart:stock markets;chip:technology
chip:Qwen;server:server
chip:AI;document:Home Office
robot:robot dogs;document:petition
ballot:elections;shield:security policy
speech:dialogue;people:parties
shield:protect citizens;gavel:law
gavel:Judicial Council;document:amnesty
home:Lebanon|areas;warning:strikes
network:command-and-control;document:Reuters
people:Ambassador;agreement:discuss
people:Ambassador;art:Culture
speech:responded|readiness;shield:threats
plane:travel;agreement:agreement
inbox:congratulations;ballot:re-election
people:President;agreement:cooperation
agreement:agreements;factory:infrastructure
bank:Mizuho;people:met
medical:health centers;baby:Baby-Friendly
dress:Fashion;globe:global markets
home:Build Your House;people:Minister
phone:technology;people:human connections
pottery:ceramic;home:Museum
home:Museum;art:artworks
chip:AI Campus;people:jobs
plane:Ottawa;agreement:partnership
road:speed limits;train:Rail
speech:political pathway;people:Palestinians
home:housing;agreement:agreement
tent:camping;car:caravan
gavel:fined;document:documents
agreement:agreements;factory:companies
ticket:Lottery;coin:Dh5 million
document:bond;leaf:renewable energy
art:art;gavel:auction
road:Street;car:accident
heart:heart;medical:care
speech:misinformation;pill:treatments
medical:surgery centers;document:deal
eye:eyes;medical:Doctors
calendar:November;medical:doctors
pan:cookware;shield:safety
home:units;baby:maternity
pharmacy:pharmacies;document:audits
pill:drug;clock:awaiting
pill:drug;scan:trials
syringe:vaccine;document:approval
mushroom:waxcap;magnify:identified|expedition
dna:traits;scan:screening
speech:misinformation;pill:treatments
factory:emissions;globe:world
atom:Fusion;document:awards
volcano:eruption;globe:worldwide
chip:AI;shield:safety
bird:bird flu;chip:chatbot
satellite:space;mirror:mirror
monkey:monkeys;scan:tests
eye:trypophobia;speech:disgust
moon:Phobos;plane:mission
microphone:Jay-Z;stadium:Stadium
music:song;gavel:sued
headphones:podcast;document:acquisitions
film:Pictures;people:marketing
video:Disney+;agreement:agreement
film:Film Festival;ribbon:A-list
film:TIFFCOM;globe:Japan
book:Dictionary;document:Maxxing
stage:Theatre;home:building
music:rock;flower:died
video:series;document:IMDb
music:song;video:music video
football:World Cup|match;pause:abandoned
jersey:Williams;medical:surgery
jersey:Caruso;medical:ankle
calendar:weeks;medical:knee
jersey:Jazz;scan:MRIs|injuries
ball:NBA;agreement:partnership
ball:Knicks;baby:son
jersey:Brown;speech:denied
ball:points;clock:minutes
jersey:Wales;people:debutants
ballot:presidential;document:51.79 percent
ballot:election;document:polls
home:rough sleeper;coin:funding
people:pensioners;document:income tax
car:driving;receipt:tariff
podium:rally;ballot:campaign
podium:Trump;shield:NAACP
chip:AI;document:Home Office
home:Downing Street;desk:workplace
podium:campaign;football:football
desk:employees;document:buyouts
document:IPO;shield:safeguards
receipt:registers;tag:shelf prices
bank:banks;coin:stablecoin
document:rules;clock:60-day
coin:cryptocurrency;calendar:2029
people:pensioners;document:income tax
calendar:calendar;people:family
film:TIFFCOM;globe:Japan
chart:stock markets;chip:artificial intelligence
people:caregiver;home:family
desk:employees;chip:artificial intelligence
document:stock listing;shield:safeguards
foldphone:iPhone Duo;warning:cracking
video:horizontal videos;clock:90 minutes
tablet:iPad mini;chip:A20 Pro
chart:stock markets;chip:artificial intelligence
chip:Qwen;shield:sandbox
foldphone:iPhone Duo;agreement:replace
phone:iPhone;lock:Lockdown Mode
chip:artificial intelligence;document:Home Office
coin:offering;server:infrastructure
ballot:election;document:51.79 percent
passport:passports;gavel:investigation
ballot:election;people:voters
border:border crossing;stop:closing
suitcase:exile;home:return
ballot:elections;document:parliament
gavel:judge;desk:reinstatement
football:Kane;trophy:Ballon d'Or
plane:tour;medical:surgery
gavel:sentenced;music:singer
atom:physics;chip:AI
`.trim().split('\n').map(s=>s.replace('ring:','ribbon:'));

// Full summaries not represented in that edition's short recap.
export const extraDesigns = {
 13:'jersey:Wales;people:players',
 17:'football:striker;jersey:Arsenal',
 28:'document:filed;bank:Nasdaq',
 30:'agreement:partnered;document:contracts',
 31:'coin:Ethereum;wallet:treasury',
 33:'document:listing;bank:stock market',
 40:'factory:natural gas;server:data centre',
 42:'phone:iOS;microphone:Siri',
 47:'shield:protect its citizens;gavel:law',
 51:'people:Ambassador;agreement:talks',
 63:'home:Museums;art:works',
 76:'chip:Artificial Intelligence Campus;people:jobs',
 85:'document:bond;leaf:green notes',
 88:'heart:cardiovascular;medical:care',
 89:'speech:misinformation;pill:treatment',
 92:'eye:eyes;medical:removal',
 98:'pill:drug;scan:testing',
 105:'volcano:eruption;globe:global',
 108:'satellite:satellites;globe:Earth',
 112:'microphone:Jay-Z;stage:halftime show',
 122:'video:shows;document:IMDb',
 134:'ball:points;clock:overtime',
 136:'ballot:presidential;document:votes',
 137:'ballot:election;document:polling',
 140:'people:pensioners;document:tax',
 158:'people:mother;home:family',
 160:'document:public offering;shield:safeguards',
 162:'video:video;clock:90 minutes',
 166:'chip:Qwen;shield:security',
 169:'chip:AI;document:Home Office',
 171:'ballot:presidential;document:vote',
 174:'border:border crossing;stop:close',
 177:'suitcase:returned;people:supporters',
 5:'ball:Knicks;baby:son',
 19:'football:tournament;calendar:January',
 41:'medical:health record;lock:security',
 64:'shield:air defenses;agreement:met',
 65:'speech:dialogue;agreement:joint statement',
 66:'phone:phone call;people:Minister',
 67:'speech:negotiations;plane:visit',
 68:'phone:app;border:border',
 69:'car:vehicles;warning:defect',
 70:'tank:storage;agreement:arrangement',
 71:'football:Al-Hilal;jersey:Al-Shamal',
 72:'ticket:ticket;document:regulations',
 73:'football:tournament;calendar:January',
 74:'microphone:stories|speech;people:families',
 75:'people:ambassador;agreement:discuss',
 90:'pill:drug;scan:study',
 124:'football:Kane;trophy:Ballon',
 127:'golf:Golf;document:confirmed',
 138:'gavel:charged;document:information',
 150:'bank:Bank;coin:stablecoin',
 165:'calendar:calendar;inbox:assistant',
 175:'gavel:charged;document:information',
};
