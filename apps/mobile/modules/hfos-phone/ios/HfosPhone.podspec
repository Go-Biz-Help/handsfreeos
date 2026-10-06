Pod::Spec.new do |s|
  s.name           = 'HfosPhone'
  s.version        = '1.0.0'
  s.summary        = 'What HandsFreeOS asks the phone itself.'
  s.description    = 'Whether the phone is locked, opening a page on the web in the browser rather than in the app, adding a contact, and showing a kept document.'
  s.license        = { :type => 'UNLICENSED' }
  s.author         = 'Go Biz Help'
  s.homepage       = 'https://handsfreeos.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Contacts', 'ContactsUI', 'QuickLook'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
