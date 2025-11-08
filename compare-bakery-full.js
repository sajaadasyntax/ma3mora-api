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

// Seed file data (from seed-all.ts)
const seedData = [
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
  { name: 'ابراهيم محمد قرية محمد زين', amount: 3525000 },
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
  { name: 'عبد العظيم عثمان حله جديده', amount: 3520500 },
  { name: 'سامي ود البحر', amount: 4060000 },
  { name: 'نادر ود حلو', amount: 1644000 },
  { name: 'عادل نادي المريخ فرم', amount: 5210200 },
  { name: 'سامى مخبز الملك 2', amount: 3525000 },
  { name: 'خالد - مدرسة المجد', amount: 174000 },
  { name: 'محمد دفع الله اب سم', amount: 150000 },
  { name: 'عمر مضوي', amount: 30000 },
  { name: 'حساب المخبز محمد + عمر', amount: 18682000 },
  { name: 'مركز معتوق - ممدوح', amount: 167315600 },
  { name: 'مركز القرشي - عدي', amount: 105662000 },
  { name: 'مركز الهدى', amount: 2042300 },
  { name: 'مركز عبود', amount: 1847600 },
  { name: 'مجدي الطيب', amount: 25078600 },
  { name: 'محمد عادل - نادي المريخ', amount: 3000000 },
  { name: 'خالد يوسف', amount: 1000000 },
  { name: 'مركز القرشي - محمد علي', amount: 70828160 },
];

console.log('Comparing bakery customers from image with seed file...\n');
console.log('Image entries:', imageData.length);
console.log('Seed file entries:', seedData.length);
console.log('');

// Create maps for easy lookup (normalize names for comparison)
const normalizeName = (name) => name.replace(/\s+/g, ' ').trim().replace(/[یي]/g, 'ي');

const imageMap = new Map();
imageData.forEach(item => {
  const normalized = normalizeName(item.name);
  if (imageMap.has(normalized)) {
    console.log(`⚠️  Duplicate in image: ${item.name}`);
  }
  imageMap.set(normalized, item.amount);
});

const seedMap = new Map();
seedData.forEach(item => {
  const normalized = normalizeName(item.name);
  seedMap.set(normalized, item.amount);
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

// Find name variations (similar names with same amount)
const nameVariations = [];
imageData.forEach(item => {
  const normalized = normalizeName(item.name);
  if (!seedMap.has(normalized)) {
    // Try to find similar names
    seedData.forEach(seedItem => {
      const seedNormalized = normalizeName(seedItem.name);
      if (normalized !== seedNormalized && seedItem.amount === item.amount) {
        // Check if names are similar (contain each other or very close)
        if (normalized.includes(seedNormalized) || seedNormalized.includes(normalized) || 
            normalized.replace(/\s+/g, '') === seedNormalized.replace(/\s+/g, '')) {
          nameVariations.push({
            image: item.name,
            seed: seedItem.name,
            amount: item.amount
          });
        }
      }
    });
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

if (nameVariations.length > 0) {
  console.log('⚠️  Name variations (same amount, different spelling):', nameVariations.length);
  nameVariations.forEach(variation => {
    console.log(`  - Image: "${variation.image}"`);
    console.log(`    Seed:  "${variation.seed}"`);
    console.log(`    Amount: ${variation.amount.toLocaleString()}`);
  });
}

console.log('');

// Calculate totals
const imageTotal = imageData.reduce((sum, item) => sum + item.amount, 0);
const seedTotal = seedData.reduce((sum, item) => sum + item.amount, 0);

console.log('Totals:');
console.log(`  Image total: ${imageTotal.toLocaleString()}`);
console.log(`  Seed total:  ${seedTotal.toLocaleString()}`);
console.log(`  Difference:  ${(imageTotal - seedTotal).toLocaleString()}`);
