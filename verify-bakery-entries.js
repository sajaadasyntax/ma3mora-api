// Image: Full bakery customers list (54 entries from image)
const imageData = [
  { name: 'عصام ود ابراهيم', amount: 24461600 },
  { name: 'موسى الصادق - الكشيف', amount: 16109600 },
  { name: 'مخبز ام القرى', amount: 40570650 },
  { name: 'مخبز الشهيد', amount: 8035800 },
  { name: 'عادل عثمان ابو شوك', amount: 13502900 },
  { name: 'محمد نصر الدين', amount: 14825000 },
  { name: 'علي صالح', amount: 7708600 },
  { name: 'موسى الصادق - لؤلؤة', amount: 20590500 },
  { name: 'احباب الرسول', amount: 1582000 },
  { name: 'ابراهيم الحبشي', amount: 16580150 },
  { name: 'عبدالمولى حسن', amount: 3900000 },
  { name: 'التوم حميدان', amount: 45421500 },
  { name: 'عوض الجيد عبود', amount: 4160000 },
  { name: 'حاتم الشايقي', amount: 5802550 },
  { name: 'محمد ابو ادريس', amount: 100000 },
  { name: 'احمد عمر بطه', amount: 14892000 },
  { name: 'احمد حسین', amount: 1325000 },
  { name: 'محمد يوسف الجوهرة', amount: 19900000 },
  { name: 'سلفيات العتالة', amount: 60000 },
  { name: 'مخبز الاحسان - حمد', amount: 1000500 },
  { name: 'خالد عبدالقادر', amount: 455000 },
  { name: 'مكاوي بورتسودان', amount: 137100 },
  { name: 'محمدين صوبان', amount: 250000 },
  { name: 'خالد مخبز دریبو', amount: 5800000 },
  { name: 'ابراهیم محمد قرية محمد زين', amount: 3525000 },
  { name: 'عادل ابراهيم', amount: 193000 },
  { name: 'مخبز الجودي - الامين موسى', amount: 1245000 },
  { name: 'احمد الريح - ابو فلج', amount: 1171500 },
  { name: 'حافظ عبدالله - الصلاة على النبي', amount: 6409500 },
  { name: 'عبدالله الامام', amount: 223000 },
  { name: 'محمد ود البحر', amount: 26460000 },
  { name: 'مهدي التوحيد - ام طلحه', amount: 193500 },
  { name: 'محمد مصطفى - الشكينيبة', amount: 198000 },
  { name: 'مدثر الفزاري', amount: 1308500 },
  { name: 'ياسر الطاهر ام طلحه', amount: 2440350 },
  { name: 'الطيب صلاح', amount: 2542500 },
  { name: 'لؤي مصطفى', amount: 1755000 },
  { name: 'فهمي طلحه ود محمود', amount: 3246000 },
  { name: 'الجيلي عبدالله', amount: 482000 },
  { name: 'هيثم حمد النيل', amount: 80000 },
  { name: 'بنج', amount: 30000 },
  { name: 'حاج علي - علي الامين', amount: 2640000 },
  { name: 'عبد العزيز بابكر - ام طلحه عمر مضوي', amount: 1782000 },
  { name: 'ابایزید عبود', amount: 7702500 },
  { name: 'ابراهیم عبود', amount: 2306000 },
  { name: 'احمد محمد حسن - الحله جديده', amount: 2850000 },
  { name: 'عصام يوسف - الحله جديده', amount: 2995500 },
  { name: 'احمد يوسف', amount: 887000 },
  { name: 'عبدالعظيم عثمان حله جديده', amount: 3520500 },
  { name: 'سامي ود البحر', amount: 4060000 },
  { name: 'نادر ود حلو', amount: 1644000 },
  { name: 'عادل نادي المريخ فرم', amount: 5210200 },
  { name: 'سامي مخبز الملك 2', amount: 3525000 },
  { name: 'خالد - مدرسة المجد', amount: 174000 },
];

// Read seed file data
const fs = require('fs');
const seedContent = fs.readFileSync('prisma/seed-all.ts', 'utf8');

// Extract bakeryCustomers array
const bakeryCustomersMatch = seedContent.match(/const bakeryCustomers = \[([\s\S]*?)\];/);
if (!bakeryCustomersMatch) {
  console.error('Could not find bakeryCustomers array in seed file');
  process.exit(1);
}

// Parse the array content
const arrayContent = bakeryCustomersMatch[1];
const seedEntries = [];

// Extract each entry using regex
const entryRegex = /\{\s*name:\s*['"]([^'"]+)['"],\s*amount:\s*(\d+)\s*\}/g;
let match;
while ((match = entryRegex.exec(arrayContent)) !== null) {
  seedEntries.push({
    name: match[1],
    amount: parseInt(match[2])
  });
}

console.log(`Found ${seedEntries.length} entries in seed file\n`);

// Normalize names for comparison
const normalizeName = (name) => name.replace(/\s+/g, ' ').trim().replace(/[یي]/g, 'ي');

// Create seed map
const seedMap = new Map();
seedEntries.forEach(item => {
  const normalized = normalizeName(item.name);
  seedMap.set(normalized, item.amount);
});

// Check each image entry
console.log('=== VERIFICATION ===\n');
let allFound = true;
const missing = [];

imageData.forEach((item, index) => {
  const normalized = normalizeName(item.name);
  if (seedMap.has(normalized)) {
    const seedAmount = seedMap.get(normalized);
    if (seedAmount === item.amount) {
      console.log(`✅ ${index + 1}. ${item.name}: ${item.amount.toLocaleString()}`);
    } else {
      console.log(`❌ ${index + 1}. ${item.name}: Amount mismatch! Image: ${item.amount.toLocaleString()}, Seed: ${seedAmount.toLocaleString()}`);
      allFound = false;
      missing.push({ ...item, issue: 'amount_mismatch', seedAmount });
    }
  } else {
    console.log(`❌ ${index + 1}. ${item.name}: NOT FOUND in seed file!`);
    allFound = false;
    missing.push({ ...item, issue: 'not_found' });
  }
});

console.log('\n=== SUMMARY ===\n');
if (allFound) {
  console.log('✅ All 54 image entries are present in the seed file with correct amounts!');
} else {
  console.log(`❌ Found ${missing.length} issues:`);
  missing.forEach(item => {
    if (item.issue === 'not_found') {
      console.log(`  - Missing: ${item.name} (${item.amount.toLocaleString()})`);
    } else {
      console.log(`  - Amount mismatch: ${item.name} (Image: ${item.amount.toLocaleString()}, Seed: ${item.seedAmount.toLocaleString()})`);
    }
  });
}

