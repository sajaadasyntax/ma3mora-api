// Image 1: Bakery customers/accounts (11 entries)
const image1Data = [
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

// Image 2: Bakery customers (6 entries)
const image2Data = [
  { name: 'مخبز ام القرى', amount: 40570650 },
  { name: 'مخبز الشهيد', amount: 8035800 },
  { name: 'مخبز الاحسان - حمد', amount: 1000500 },
  { name: 'خالد مخبز دریبو', amount: 5800000 },
  { name: 'مخبز الجودي - الامين موسى', amount: 1245000 },
  { name: 'سامى مخبز الملك 2', amount: 3525000 },
];

const allImageData = [...image1Data, ...image2Data];

console.log('Comparing bakery customers...\n');
console.log('Image 1 entries:', image1Data.length);
console.log('Image 2 entries:', image2Data.length);
console.log('Total image entries:', allImageData.length);
console.log('');

// Calculate totals
const imageTotal = allImageData.reduce((sum, item) => sum + item.amount, 0);
console.log('Total amount from images:', imageTotal.toLocaleString());
console.log('');

// Display all entries for manual comparison
console.log('All entries from images:');
allImageData.forEach((item, index) => {
  console.log(`${index + 1}. ${item.name}: ${item.amount.toLocaleString()}`);
});

