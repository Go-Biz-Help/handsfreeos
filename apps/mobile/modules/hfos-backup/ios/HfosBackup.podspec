Pod::Spec.new do |s|
  s.name           = 'HfosBackup'
  s.version        = '1.0.0'
  s.summary        = 'Keeps the phone copy of the business out of backups.'
  s.description    = 'Keeps the encrypted copy of each business, and photos waiting to upload, out of iCloud and computer backups.'
  s.license        = { :type => 'UNLICENSED' }
  s.author         = 'Go Biz Help'
  s.homepage       = 'https://handsfreeos.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
