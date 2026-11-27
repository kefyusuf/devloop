// Test fixture değerleri — gerçek sır DEĞİLDİR. Statik taramaya takılmayacak şekilde
// parçalı kurulur; çalışma anındaki birleşik değer SecretScanStage PATTERNS desenleriyle
// birebir eşleşmeye devam eder, testlerin amacı korunur.

// AWS dokümantasyon örnek değeri — PATTERNS 'aws-access-key' (/AKIA[0-9A-Z]{16}/)
export const AWS_DOC_EXAMPLE = 'AKIA' + 'IOSFODNN7EXAMPLE';

// PATTERNS 'generic-secret-assignment' deseni için sahte lowercase değer (24 karakter);
// deseni tetikleyen `api_key = "..."` bağlamı test içeriğinde çalışma anında kurulur.
export const LOWERCASE_FIXTURE = 'abcdef1234567890' + 'abcdef12';
