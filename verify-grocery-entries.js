// Image: Grocery customers (28 entries from image)
const imageData = [
  { name: 'عبدالوهاب دفع الله اب سم', amount: 19433850 },
  { name: 'بقالة البركة - يور / اب سم', amount: 1554000 },
  { name: 'اسعد الزمزمي', amount: 57750 },
  { name: 'عزالدين الحوري', amount: 33618000 },
  { name: 'اسعد مبارك', amount: 296000 },
  { name: 'مبارك الطيب', amount: 211600 },
  { name: 'خالد مدرسة المجد', amount: 488700 },
  { name: 'هيثم حمد النيل', amount: 91450 },
  { name: 'محمد عوض', amount: 730000 },
  { name: 'عابدين محمد - معتوق', amount: 5000 },
  { name: 'حسين علي', amount: 74100 },
  { name: 'اسامه ابراهیم', amount: 351500 },
  { name: 'محمد مهدي', amount: 640000 },
  { name: 'مرکز معتوق ممدوح', amount: 16377800 },
  { name: 'مركز القرشي - عدي', amount: 31704500 },
  { name: 'علي اب رش الكريمت', amount: 1520000 },
  { name: 'عبد الرحمن عبدالله', amount: 41200 },
  { name: 'حافظ الطيب - العزازي', amount: 37420000 },
  { name: 'محمد عبدالله الحرمين', amount: 1025000 },
  { name: 'فاروق الحوري - معتوق', amount: 4375000 },
  { name: 'بقالة ام القري', amount: 1420000 },
  { name: 'مصعب ميرغني', amount: 102000 },
  { name: 'ود ابراهيم', amount: 180000 },
  { name: 'عبد العزيز اب سم', amount: 282500 },
  { name: 'منصور علي', amount: 121000 },
  { name: 'مركز الهدي', amount: 82700 },
  { name: 'جنابو بكري', amount: 30000 },
  { name: 'يوسف احمد يوسف - بنك النيل', amount: 816000 },
];

// Read seed file data
const fs = require('fs');
const seedContent = fs.readFileSync('prisma/seed-all.ts', 'utf8');

// Extract groceryCustomers array
const groceryCustomersMatch = seedContent.match(/const groceryCustomers = \[([\s\S]*?)\];/);
if (!groceryCustomersMatch) {
  console.error('Could not find groceryCustomers array in seed file');
  process.exit(1);
}

// Parse the array content
const arrayContent = groceryCustomersMatch[1];
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

// Normalize names for comparison (handle variations)
const normalizeName = (name) => {
  return name
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[یي]/g, 'ي')
    .replace(/[کك]/g, 'ك');
};

// Create seed map
const seedMap = new Map();
seedEntries.forEach(item => {
  const normalized = normalizeName(item.name);
  if (seedMap.has(normalized)) {
    console.log(`⚠️  Duplicate in seed: ${item.name}`);
  }
  seedMap.set(normalized, { name: item.name, amount: item.amount });
});

// Check each image entry
console.log('=== VERIFICATION ===\n');
let allFound = true;
const missing = [];
const nameVariations = [];

imageData.forEach((item, index) => {
  const normalized = normalizeName(item.name);
  const seedEntry = seedMap.get(normalized);
  
  if (seedEntry) {
    if (seedEntry.amount === item.amount) {
      if (seedEntry.name !== item.name) {
        console.log(`⚠️  ${index + 1}. Name variation: "${item.name}" (image) vs "${seedEntry.name}" (seed) - Amount: ${item.amount.toLocaleString()}`);
        nameVariations.push({ image: item.name, seed: seedEntry.name, amount: item.amount });
      } else {
        console.log(`✅ ${index + 1}. ${item.name}: ${item.amount.toLocaleString()}`);
      }
    } else {
      console.log(`❌ ${index + 1}. ${item.name}: Amount mismatch! Image: ${item.amount.toLocaleString()}, Seed: ${seedEntry.amount.toLocaleString()}`);
      allFound = false;
      missing.push({ ...item, issue: 'amount_mismatch', seedAmount: seedEntry.amount, seedName: seedEntry.name });
    }
  } else {
    // Try to find similar names
    let foundSimilar = false;
    seedEntries.forEach(seedItem => {
      const seedNormalized = normalizeName(seedItem.name);
      if (normalized === seedNormalized && seedItem.amount === item.amount) {
        foundSimilar = true;
        console.log(`⚠️  ${index + 1}. Name variation: "${item.name}" (image) vs "${seedItem.name}" (seed) - Amount: ${item.amount.toLocaleString()}`);
        nameVariations.push({ image: item.name, seed: seedItem.name, amount: item.amount });
      }
    });
    
    if (!foundSimilar) {
      console.log(`❌ ${index + 1}. ${item.name}: NOT FOUND in seed file!`);
      allFound = false;
      missing.push({ ...item, issue: 'not_found' });
    }
  }
});

console.log('\n=== SUMMARY ===\n');
if (allFound && nameVariations.length === 0) {
  console.log('✅ All 28 image entries are present in the seed file with correct names and amounts!');
} else {
  if (nameVariations.length > 0) {
    console.log(`⚠️  Found ${nameVariations.length} name variations (same amount, different spelling):`);
    nameVariations.forEach(variation => {
      console.log(`  - Image: "${variation.image}"`);
      console.log(`    Seed:  "${variation.seed}"`);
      console.log(`    Amount: ${variation.amount.toLocaleString()}`);
    });
    console.log('');
  }
  
  if (missing.length > 0) {
    console.log(`❌ Found ${missing.length} issues:`);
    missing.forEach(item => {
      if (item.issue === 'not_found') {
        console.log(`  - Missing: ${item.name} (${item.amount.toLocaleString()})`);
      } else {
        console.log(`  - Amount mismatch: ${item.name} (Image: ${item.amount.toLocaleString()}, Seed: ${item.seedAmount.toLocaleString()})`);
      }
    });
  } else if (allFound) {
    console.log('✅ All entries found with correct amounts (some name variations detected above)');
  }
}

// Calculate totals
const imageTotal = imageData.reduce((sum, item) => sum + item.amount, 0);
const seedTotal = seedEntries.reduce((sum, item) => sum + item.amount, 0);

console.log('\n=== TOTALS ===');
console.log(`  Image total: ${imageTotal.toLocaleString()}`);
console.log(`  Seed total:  ${seedTotal.toLocaleString()}`);
console.log(`  Difference:  ${(imageTotal - seedTotal).toLocaleString()}`);

