// Image: Grocery customers (28 entries)
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

// Seed file data (from what I read)
const seedData = [
  { name: 'عبد الوهاب دفع الله اب سم', amount: 19433850 },
  { name: 'بقالة البركة - يور / اب سم', amount: 1554000 },
  { name: 'اسعد الزمزمي', amount: 57750 },
  { name: 'عزالدين الحوري', amount: 33618000 },
  { name: 'اسعد مبارك', amount: 296000 },
  { name: 'مبارك الطيب', amount: 211600 },
  { name: 'خالد مدرسة المجد', amount: 488700 },
  { name: 'هيثم حمد النيل', amount: 91450 },
  { name: 'محمد عوض', amount: 730000 },
  { name: 'عابدین محمد - معتوق', amount: 5000 },
  { name: 'حسين علي', amount: 74100 },
  { name: 'اسامه ابراهیم', amount: 351500 },
  { name: 'محمد مهدي', amount: 640000 },
  { name: 'مرکز معتوق - ممدوح', amount: 16377800 },
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
];

console.log('Comparing grocery customers...\n');
console.log('Image entries:', imageData.length);
console.log('Seed file entries:', seedData.length);
console.log('');

// Create maps for easy lookup (normalize names for comparison)
const normalizeName = (name) => name.replace(/\s+/g, ' ').trim();

const imageMap = new Map();
imageData.forEach(item => {
  imageMap.set(normalizeName(item.name), item.amount);
});

const seedMap = new Map();
seedData.forEach(item => {
  seedMap.set(normalizeName(item.name), item.amount);
});

// Find missing in seed
const missingInSeed = [];
imageData.forEach(item => {
  const normalized = normalizeName(item.name);
  if (!seedMap.has(normalized)) {
    missingInSeed.push(item);
  }
});

// Find missing in images
const missingInImages = [];
seedData.forEach(item => {
  const normalized = normalizeName(item.name);
  if (!imageMap.has(normalized)) {
    missingInImages.push(item);
  }
});

// Find amount differences
const amountDifferences = [];
imageData.forEach(item => {
  const normalized = normalizeName(item.name);
  if (seedMap.has(normalized)) {
    const seedAmount = seedMap.get(normalized);
    if (seedAmount !== item.amount) {
      amountDifferences.push({
        name: item.name,
        imageAmount: item.amount,
        seedAmount: seedAmount,
        difference: item.amount - seedAmount
      });
    }
  }
});

console.log('=== RESULTS ===\n');
if (missingInSeed.length > 0) {
  console.log('❌ Missing in seed file:', missingInSeed.length);
  missingInSeed.forEach(item => {
    console.log(`  - ${item.name}: ${item.amount.toLocaleString()}`);
  });
} else {
  console.log('✅ All image entries exist in seed file');
}

console.log('');

if (missingInImages.length > 0) {
  console.log('⚠️  In seed file but not in images:', missingInImages.length);
  missingInImages.forEach(item => {
    console.log(`  - ${item.name}: ${item.amount.toLocaleString()}`);
  });
} else {
  console.log('✅ All seed entries exist in images');
}

console.log('');

if (amountDifferences.length > 0) {
  console.log('❌ Amount differences:', amountDifferences.length);
  amountDifferences.forEach(diff => {
    console.log(`  - ${diff.name}:`);
    console.log(`    Image: ${diff.imageAmount.toLocaleString()}`);
    console.log(`    Seed:  ${diff.seedAmount.toLocaleString()}`);
    console.log(`    Diff:  ${diff.difference > 0 ? '+' : ''}${diff.difference.toLocaleString()}`);
  });
} else {
  console.log('✅ All amounts match');
}

console.log('');

// Check for name variations
console.log('Checking for name variations...');
imageData.forEach(item => {
  const normalized = normalizeName(item.name);
  if (!seedMap.has(normalized)) {
    // Try to find similar names
    let found = false;
    seedData.forEach(seedItem => {
      const seedNormalized = normalizeName(seedItem.name);
      if (normalized.includes(seedNormalized) || seedNormalized.includes(normalized)) {
        if (seedItem.amount === item.amount) {
          console.log(`  ⚠️  Possible match: "${item.name}" (image) vs "${seedItem.name}" (seed)`);
          found = true;
        }
      }
    });
    if (!found) {
      console.log(`  ❌ Not found: "${item.name}"`);
    }
  }
});

console.log('');

// Calculate totals
const imageTotal = imageData.reduce((sum, item) => sum + item.amount, 0);
const seedTotal = seedData.reduce((sum, item) => sum + item.amount, 0);

console.log('Totals:');
console.log(`  Image total: ${imageTotal.toLocaleString()}`);
console.log(`  Seed total:  ${seedTotal.toLocaleString()}`);
console.log(`  Difference:  ${(imageTotal - seedTotal).toLocaleString()}`);

