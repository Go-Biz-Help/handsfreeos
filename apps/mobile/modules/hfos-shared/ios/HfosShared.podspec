Pod::Spec.new do |s|
  s.name           = 'HfosShared'
  s.version        = '1.0.0'
  s.summary        = 'What HandsFreeOS keeps for its keyboard and widgets.'
  s.description    = 'A JSON file per key in the App Group the app shares with its keyboard and widgets, kept out of backups.'
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
